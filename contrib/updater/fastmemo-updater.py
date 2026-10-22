#!/usr/bin/env python3
"""fastmemo-server updater: installs a newer release when the dashboard asks for one.

Runs as root on the host. The server only ever leaves a wish (a version number in a folder); everything here is decided
again:

- from the request only a version number is read (no symlinks, no special files, a few bytes at most);
- the server must be the published image on SQLite, its data in a volume at /data, as the running container shows
  (PostgreSQL and source builds are updated by hand, with the commands the dashboard shows);
- the version must be newer than the running one, of the same major, and a published, non-prerelease release of the
  configured repo;
- the downloaded image must say it was built from that repository for that version, and its build provenance is
  verified against the exact digest that will run when the GitHub CLI and a token are available (always, with
  VERIFY_PROVENANCE=required).

The dashboard reads progress from a status file in a folder the server can't write to. Messages are fixed strings:
nothing the server wrote is ever echoed back.
"""

import fcntl
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

VERSION = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", re.ASCII)
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", re.ASCII)
IMAGE = re.compile(r"[a-z0-9.-]+(?::[0-9]+)?(?:/[a-z0-9._-]+)+", re.ASCII)
NAME = re.compile(r"[A-Za-z0-9_.-]+", re.ASCII)
WORKFLOW = re.compile(r"[A-Za-z0-9_./-]+\.ya?ml", re.ASCII)
DIGEST = re.compile(r"sha256:[0-9a-f]{64}", re.ASCII)
CONTAINER_ID = re.compile(r"[0-9a-f]{12,64}", re.ASCII)
POSTGRES = re.compile(r"postgres(ql)?://", re.ASCII | re.IGNORECASE)
MAX_REQUEST_BYTES = 1024
MAX_RELEASE_BYTES = 1024 * 1024
DATA = "/data"
DEFAULTS = {
    "REPO": "ontech7/fastmemo-server",
    "IMAGE": "ghcr.io/ontech7/fastmemo-server",
    "GITHUB_API": "https://api.github.com",
    "COMPOSE_FILE": "docker-compose.yml:contrib/updater/compose.updater.yaml",
    "ENV_FILE": "",
    "SERVICE": "fastmemo",
    "REQUEST_DIR": "/var/lib/fastmemo-update/request",
    "STATUS_DIR": "/var/lib/fastmemo-update/status",
    "BACKUP_DIR": "/var/lib/fastmemo-update/backup",
    "HEALTH_TIMEOUT": "120",
    "COOLDOWN": "15",
    "VERIFY_PROVENANCE": "auto",
    "SIGNER_WORKFLOW": ".github/workflows/release.yml",
}
SOURCE_BUILD = "this server runs an image built from source: update it with the commands in the dashboard"


class Refused(Exception):
    """A request this setup or this version doesn't allow (final state "refused"), with a message safe to show."""


class Failed(Exception):
    """A request that could not be carried out (final state "failed"), with a message safe to show."""


def load_config(path):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        sys.exit(f"{path} must be a regular file owned by this user and not writable by group or others")
    config = dict(DEFAULTS)
    with open(path, encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                config[key.strip()] = value.strip().strip("'\"")
    if not os.path.isabs(config.get("COMPOSE_DIR", "")):
        sys.exit("COMPOSE_DIR must be set to the absolute path of the fastmemo-server checkout")
    if (
        not REPO.fullmatch(config["REPO"])
        or not IMAGE.fullmatch(config["IMAGE"])
        or not NAME.fullmatch(config["SERVICE"])
        or not WORKFLOW.fullmatch(config["SIGNER_WORKFLOW"])
        or not re.match(r"https?://", config["GITHUB_API"])
        or not config["HEALTH_TIMEOUT"].isdigit()
        or not config["COOLDOWN"].isdigit()
        or config["VERIFY_PROVENANCE"] not in ("auto", "required", "off")
    ):
        sys.exit(f"{path} has a value that is not valid: compare it with updater.env.example")
    # Relative to the checkout, like docker compose run from there.
    directory = config["COMPOSE_DIR"]
    config["COMPOSE_FILES"] = [os.path.join(directory, file) for file in config["COMPOSE_FILE"].split(":") if file]
    config["ENV_FILE"] = os.path.join(directory, config["ENV_FILE"] or ".env")
    return config


def write_file(path, text, mode):
    """Replaces a file atomically: a reader sees the old content or the new one, never half of it."""
    handle, temporary = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".fastmemo-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        remove(temporary)
        raise


class Status:
    """status.json, read by the server through a read-only mount: world-readable, since it runs as another user."""

    def __init__(self, directory):
        self.path = os.path.join(directory, "status.json")
        self.version = "0.0.0"
        # Whether the image's provenance was verified: None until it was looked at.
        self.verified = None

    def write(self, state, message=None):
        record = {
            "state": state,
            "version": self.version,
            "message": message,
            "at": int(time.time() * 1000),
            "verified": self.verified,
        }
        write_file(self.path, json.dumps(record), 0o644)


def remove(path):
    """Removes whatever is at path without following symlinks. Never raises: a leftover is retried next run."""
    try:
        if stat.S_ISDIR(os.lstat(path).st_mode):
            shutil.rmtree(path)
        else:
            os.unlink(path)
    except OSError:
        pass


def take_request(directory):
    """The requested version, or None when there is no request. The request is always removed."""
    path = os.path.join(directory, "request.json")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        remove(path)
        raise Failed("the request was not a plain file")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REQUEST_BYTES:
            raise Failed("the request was not a small plain file")
        raw = os.read(fd, MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise Failed("the request was not a small plain file")
    finally:
        os.close(fd)
        remove(path)
    try:
        version = json.loads(raw.decode("utf-8")).get("version")
    except (ValueError, AttributeError, RecursionError):
        raise Failed("the request was not valid")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise Failed("the request did not name a version")
    return version


def as_tuple(version):
    return tuple(int(part) for part in version.split("."))


def github(config, path):
    request = urllib.request.Request(
        config["GITHUB_API"] + path,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "fastmemo-updater"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read(MAX_RELEASE_BYTES + 1)
        if len(raw) > MAX_RELEASE_BYTES:
            raise ValueError("too big")
        return json.loads(raw)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise Refused("this version is not a published release")
        raise Failed("GitHub could not be reached")
    except (urllib.error.URLError, OSError, ValueError, RecursionError):
        raise Failed("GitHub could not be reached")


def run(config, *args, check=True, timeout=600):
    try:
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError:
        raise Failed("docker was not found")
    except subprocess.TimeoutExpired:
        raise Failed(f"docker {args[0]} did not answer in time")
    if check and result.returncode != 0:
        raise Failed(f"docker {args[0]} failed")
    return result


def compose(config, *args, check=True, timeout=600):
    """docker compose on the user's checkout, with the same files and .env as when they start it themselves."""
    files = [arg for path in config["COMPOSE_FILES"] for arg in ("-f", path)]
    base = ["compose", "--project-directory", config["COMPOSE_DIR"], *files, "--env-file", config["ENV_FILE"]]
    return run(config, *base, *args, check=check, timeout=timeout)


def as_json(text, empty):
    try:
        value = json.loads(text or "null")
    except ValueError:
        value = None
    return value if isinstance(value, type(empty)) else empty


def inspect(config, reference, field, empty):
    result = run(config, "image", "inspect", "--format", f"{{{{json .{field}}}}}", reference, timeout=60)
    return as_json(result.stdout, empty)


def image_labels(config, reference):
    return inspect(config, reference, "Config.Labels", {})


def running_container(config):
    """The running server's container as Docker sees it: what it runs, with which settings, on which volumes."""
    ids = compose(config, "ps", "-q", config["SERVICE"], timeout=60).stdout.split()
    if len(ids) != 1 or not CONTAINER_ID.fullmatch(ids[0]):
        raise Failed("the running server was not found")
    found = as_json(run(config, "container", "inspect", ids[0], timeout=60).stdout, [])
    container = found[0] if len(found) == 1 and isinstance(found[0], dict) else {}
    settings = container.get("Config") if isinstance(container.get("Config"), dict) else {}
    env = {}
    for entry in settings.get("Env") or []:
        if isinstance(entry, str) and "=" in entry:
            key, value = entry.split("=", 1)
            env[key] = value
    mounts = container.get("Mounts")
    return {
        "image": settings.get("Image") if isinstance(settings.get("Image"), str) else "",
        "image_id": container.get("Image") if isinstance(container.get("Image"), str) else "",
        "env": env,
        "mounts": [m for m in mounts if isinstance(m, dict)] if isinstance(mounts, list) else [],
    }


def repository(reference):
    """ghcr.io/owner/name from ghcr.io/owner/name:tag@sha256:… (a registry's :port is not a tag)."""
    name = reference.split("@", 1)[0]
    if name.rfind(":") > name.rfind("/"):
        name = name[: name.rfind(":")]
    return name


def refuse(config, container):
    """Refuses a setup one click must not touch, and returns the running version.

    It is decided from the running container, not the .env: docker-compose.postgres.yml sets DATABASE_URL in the
    compose file itself. Any doubt is a refusal.
    """
    url = container["env"].get("DATABASE_URL", "").strip()
    if POSTGRES.match(url):
        raise Refused("this server runs on PostgreSQL: update it with the commands in the dashboard")
    if url:
        raise Refused("this server sets its own DATABASE_URL: update it with the commands in the dashboard")
    if container["env"].get("DATA_DIR") != DATA:
        raise Refused("the database is not in the volume at /data: update it with the commands in the dashboard")
    if not any(
        m.get("Type") == "volume"
        and m.get("Destination") == DATA
        and isinstance(m.get("Name"), str)
        and m["Name"]
        and isinstance(m.get("Source"), str)
        and os.path.isabs(m["Source"])
        for m in container["mounts"]
    ):
        raise Refused("the database is not in a volume mounted at /data: update it with the commands in the dashboard")

    # Today's users run :1 or :latest: any tag of the published image is the published image.
    if repository(container["image"]) != config["IMAGE"] or not DIGEST.fullmatch(container["image_id"]):
        raise Refused(SOURCE_BUILD)
    # The labels of the image the container runs (by id: a tag may have moved since).
    labels = image_labels(config, container["image_id"])
    version = labels.get("org.opencontainers.image.version")
    if labels.get("org.opencontainers.image.source") != f"https://github.com/{config['REPO']}" or not (
        isinstance(version, str) and VERSION.fullmatch(version)
    ):
        raise Refused(SOURCE_BUILD)
    return version


def verify_image(config, status, version):
    """Pulls the release's image and returns it pinned by digest, once it says it is that release."""
    reference = f"{config['IMAGE']}:{version}"
    run(config, "pull", "--quiet", reference)

    status.write("verifying")
    labels = image_labels(config, reference)
    if labels.get("org.opencontainers.image.source") != f"https://github.com/{config['REPO']}":
        raise Failed("the image does not come from the expected repository")
    if labels.get("org.opencontainers.image.version") != version:
        raise Failed("the image does not carry the expected version")

    digests = inspect(config, reference, "RepoDigests", [])
    prefix = config["IMAGE"] + "@"
    digest = next(
        (
            d[len(prefix) :]
            for d in digests
            if isinstance(d, str) and d.startswith(prefix) and DIGEST.fullmatch(d[len(prefix) :])
        ),
        None,
    )
    if not digest:
        raise Failed("the image digest could not be read")
    # From here on the status says whether the provenance was verified: false unless gh confirms it.
    status.verified = False
    status.verified = verify_provenance(config, version, f"{config['IMAGE']}@{digest}")
    return f"{reference}@{digest}"


def verify_provenance(config, version, pinned):
    """Checks the image that will run was built by the release workflow, from the tag of that version.

    True when verified, False when skipped (VERIFY_PROVENANCE=off, or auto without gh and a token).
    """
    mode = config["VERIFY_PROVENANCE"]
    gh = shutil.which("gh")
    ready = gh is not None and bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))
    if mode == "off" or (mode == "auto" and not ready):
        return False
    if gh is None or not ready:
        raise Failed("build provenance is required but the GitHub CLI or its token is missing")
    repo = config["REPO"]
    try:
        result = subprocess.run(
            [
                gh, "attestation", "verify", f"oci://{pinned}",
                "--repo", repo,
                "--signer-workflow", f"{repo}/{config['SIGNER_WORKFLOW']}",
                "--source-ref", f"refs/tags/v{version}",
                "--deny-self-hosted-runners",
            ],
            capture_output=True, text=True, timeout=120, check=False,
        )  # fmt: skip
    except (OSError, subprocess.TimeoutExpired):
        raise Failed("the build provenance of the image could not be verified")
    if result.returncode != 0:
        raise Failed("the build provenance of the image could not be verified")
    return True


def switch_to(config, status, current, reference):
    """Stops the server, backs up its database, runs `reference` and rolls back if it doesn't become healthy."""
    status.write("failed", "switching is not implemented yet")


def update(config, status):
    version = take_request(config["REQUEST_DIR"])
    if version is None:
        return
    status.version = version
    status.write("checking")

    current = refuse(config, running_container(config))
    if as_tuple(version) <= as_tuple(current):
        raise Refused("this version is not newer than the running one")
    if as_tuple(version)[0] != as_tuple(current)[0]:
        raise Refused("this is a new major version: update it by hand, with the commands in the dashboard")
    release = github(config, f"/repos/{config['REPO']}/releases/tags/v{version}")
    if (
        not isinstance(release, dict)
        or release.get("draft") is not False
        or release.get("prerelease") is not False
        or release.get("tag_name") != f"v{version}"
    ):
        raise Refused("this version is not a published release")

    status.write("downloading")
    reference = verify_image(config, status, version)
    switch_to(config, status, current, reference)


def cool_down(config):
    """Spaces runs out, so a flood of requests cannot keep Docker and GitHub busy."""
    mark = os.path.join(config["BACKUP_DIR"], ".last-run")
    try:
        wait = int(config["COOLDOWN"]) - (time.time() - os.stat(mark).st_mtime)
    except FileNotFoundError:
        wait = 0
    if wait > 0:
        time.sleep(min(wait, int(config["COOLDOWN"])))
    with open(mark, "w"):
        pass


def stop_on_signal(signum, _):
    # Once is enough: a second signal must not cut what the first one started short.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(f"stopped by signal {signum}")


def main():
    config = load_config(os.environ.get("FASTMEMO_UPDATER_CONFIG", "/etc/fastmemo/updater.env"))
    signal.signal(signal.SIGTERM, stop_on_signal)
    status = Status(config["STATUS_DIR"])
    os.makedirs(config["BACKUP_DIR"], mode=0o700, exist_ok=True)
    # One run at a time: the path unit and the boot run can start together.
    with open(os.path.join(config["BACKUP_DIR"], ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not os.path.lexists(os.path.join(config["REQUEST_DIR"], "request.json")):
            return
        cool_down(config)
        try:
            update(config, status)
        except Refused as refusal:
            status.write("refused", str(refusal))
        except Failed as failure:
            status.write("failed", str(failure))
        except BaseException:
            status.write("failed", "the update stopped unexpectedly: check the updater's log")
            raise


if __name__ == "__main__":
    main()
