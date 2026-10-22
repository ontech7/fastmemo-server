#!/usr/bin/env python3
"""fastmemo-server updater: installs a newer release when the dashboard asks for one.

Runs as root on the host, started by fastmemo-updater.path when the dashboard leaves a request (and once at boot, to
undo a switch a power cut interrupted). The server only ever leaves a wish (a version number in a folder); everything
here is decided again:

- from the request only a version number is read (no symlinks, no special files, a few bytes at most);
- the server must be the published image on SQLite, its data in a volume at /data, as the running container shows
  (PostgreSQL and source builds are updated by hand, with the commands the dashboard shows);
- the version must be newer than the running one, of the same major, and a published, non-prerelease release of the
  configured repo;
- the downloaded image must say it was built from that repository for that version, and its build provenance is
  verified against the exact digest that will run when the GitHub CLI and a token are available (always, with
  VERIFY_PROVENANCE=required);
- the server is stopped and its database copied before the switch, and if the new version does not become healthy,
  or the run is stopped half-way, the previous image line and database come back. A database the new version may have
  migrated never runs on the previous image (that one would refuse it).

The dashboard reads progress from a status file in a folder the server can't write to. Messages are fixed strings:
nothing the server wrote is ever echoed back.
"""

import datetime
import fcntl
import http.client
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
import traceback
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
VOLUME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*", re.ASCII)
# The .env line compose reads FASTMEMO_IMAGE from (dotenv also takes `export` and spaces around `=`).
IMAGE_SETTING = re.compile(r"[ \t]*(?:export[ \t]+)?FASTMEMO_IMAGE[ \t]*=[^\r\n]*", re.ASCII)
BACKUP_NAME = re.compile(r"[0-9]{8}-[0-9]{6}-[0-9]{6}-[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", re.ASCII)
MAX_REQUEST_BYTES = 1024
MAX_RELEASE_BYTES = 1024 * 1024
MAX_ENV_BYTES = 1024 * 1024
DATA = "/data"
FINAL_STATES = ("done", "failed", "rolled_back", "refused")
DATABASE_FILES = ("fastmemo.db", "fastmemo.db-wal", "fastmemo.db-shm")
KEEP_BACKUPS = 3
SPARE_BYTES = 256 * 1024 * 1024
STOP_TIMEOUT = 120
UP_TIMEOUT = 300
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
NOT_PLAIN = "the database in the volume is not a plain file: update it with the commands in the dashboard"
CHECK_THE_LOG = "check the updater's log (journalctl -u fastmemo-updater)"


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


def log(message):
    """For the journal (journalctl -u fastmemo-updater): what a fixed status message can't say."""
    print(f"fastmemo-updater: {message}", file=sys.stderr, flush=True)


def sync_folder(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_file(path, text, mode=None):
    """Replaces a file atomically, and on the disk before it returns: after a power cut it is the old or the new one.

    Without a mode it keeps the mode and owner of the file it replaces.
    """
    owner = None
    if mode is None:
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            info = None
        if info is not None and stat.S_ISREG(info.st_mode):
            mode, owner = stat.S_IMODE(info.st_mode), (info.st_uid, info.st_gid)
        else:
            mode = 0o600
    directory = os.path.dirname(path) or "."
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".fastmemo-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        if owner:
            os.chown(temporary, *owner)
        os.replace(temporary, path)
    except BaseException:
        remove(temporary)
        raise
    sync_folder(directory)


class Status:
    """status.json, read by the server through a read-only mount: world-readable, since it runs as another user."""

    def __init__(self, directory):
        self.path = os.path.join(directory, "status.json")
        self.version = "0.0.0"
        # Whether the image's provenance was verified: None until it was looked at.
        self.verified = None
        self.state = None

    @property
    def final(self):
        return self.state in FINAL_STATES

    def write(self, state, message=None):
        record = {
            "state": state,
            "version": self.version,
            "message": message,
            "at": int(time.time() * 1000),
            "verified": self.verified,
        }
        write_file(self.path, json.dumps(record), 0o644)
        self.state = state


class Switch:
    """switch.json, there while the server is stopped or on the new image: what to undo if the run is cut short.

    The next run (at boot, after a power cut) finds it and puts the previous image line and database back.
    """

    def __init__(self, config):
        self.directory = os.path.normpath(config["BACKUP_DIR"])
        self.path = os.path.join(self.directory, "switch.json")

    def save(self, record):
        write_file(self.path, json.dumps(record), 0o600)

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as file:
                record = json.load(file)
        except FileNotFoundError:
            return None
        except (OSError, ValueError, RecursionError):
            record = None
        if not self.valid(record):
            # Root restores what it names: a record it can't trust is dropped, never followed.
            log("switch.json was not valid and was removed: nothing was undone")
            self.clear()
            return None
        return record

    def valid(self, record):
        if not isinstance(record, dict):
            return False
        version, current, line, image, folder, data = (
            record.get(key) for key in ("version", "current", "line", "image", "folder", "data")
        )
        return (
            all(isinstance(v, str) and VERSION.fullmatch(v) for v in (version, current))
            and (line is None or (isinstance(line, str) and IMAGE_SETTING.fullmatch(line)))
            and isinstance(image, str)
            and IMAGE_SETTING.fullmatch(image)
            and (
                folder is None
                or (
                    isinstance(folder, str)
                    and os.path.dirname(folder) == self.directory
                    and BACKUP_NAME.fullmatch(os.path.basename(folder))
                )
            )
            and isinstance(data, str)
            and os.path.isabs(data)
            and (record.get("verified") is None or isinstance(record.get("verified"), bool))
        )

    def clear(self):
        remove(self.path)


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
    # http.client raises its own errors on an answer that isn't HTTP, or is cut short.
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, RecursionError):
        raise Failed("GitHub could not be reached")


def run(config, *args, check=True, timeout=600):
    try:
        result = subprocess.run(
            ["docker", *args], capture_output=True, text=True, errors="replace", timeout=timeout, check=False
        )
    except OSError:
        # Missing, not executable, or not a program at all.
        raise Failed("docker could not be run")
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
    for entry in settings.get("Env") if isinstance(settings.get("Env"), list) else []:
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


def data_volume(container):
    """The name of the volume mounted at /data, or None."""
    for mount in container["mounts"]:
        name, source = mount.get("Name"), mount.get("Source")
        if (
            mount.get("Type") == "volume"
            and mount.get("Destination") == DATA
            and isinstance(name, str)
            and VOLUME.fullmatch(name)
            and isinstance(source, str)
            and os.path.isabs(source)
        ):
            return name
    return None


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
    if data_volume(container) is None:
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
            capture_output=True, text=True, errors="replace", timeout=120, check=False,
        )  # fmt: skip
    except (OSError, subprocess.TimeoutExpired):
        raise Failed("the build provenance of the image could not be verified")
    if result.returncode != 0:
        raise Failed("the build provenance of the image could not be verified")
    return True


def read_env(path):
    """The checkout's .env: a plain file (root rewrites it), small, text."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise OSError("not a regular file")
            raw = file.read(MAX_ENV_BYTES + 1)
        if len(raw) > MAX_ENV_BYTES:
            raise OSError("too big")
        return raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        raise Failed("the .env file could not be read, nothing was changed")


def image_line(env_text):
    """The FASTMEMO_IMAGE line compose uses (the last one), or None when there is none."""
    lines = [line.rstrip("\r") for line in env_text.split("\n") if IMAGE_SETTING.fullmatch(line.rstrip("\r"))]
    return lines[-1] if lines else None


def with_image(env_text, line):
    """The .env with `line` as its only FASTMEMO_IMAGE line (none when None): every other line stays as it is."""
    lines, placed = [], False
    for each in env_text.split("\n"):
        if IMAGE_SETTING.fullmatch(each.rstrip("\r")):
            if line is not None and not placed:
                lines.append(line + ("\r" if each.endswith("\r") else ""))
                placed = True
            continue
        lines.append(each)
    if line is not None and not placed:
        if lines[-1] == "":
            lines.insert(len(lines) - 1, line)
        else:
            lines += [line, ""]
    return "\n".join(lines)


def data_folder(config, volume):
    """Where the /data volume is on the host (root can read it there)."""
    found = run(config, "volume", "inspect", "--format", "{{.Mountpoint}}", volume, timeout=60).stdout.strip()
    try:
        plain_folder = os.path.isabs(found) and stat.S_ISDIR(os.lstat(found).st_mode)
    except (OSError, ValueError):
        plain_folder = False
    if not plain_folder:
        raise Failed("the database volume was not found, nothing was changed")
    return found


def database_files(data):
    """The database files there are, with their size. Anything but plain files there is not ours to copy."""
    found = {}
    for name in DATABASE_FILES:
        try:
            info = os.lstat(os.path.join(data, name))
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(info.st_mode):
            raise Refused(NOT_PLAIN)
        found[name] = info.st_size
    if DATABASE_FILES[0] not in found:
        raise Failed("the database was not found, nothing was changed")
    return found


def check_space(config, files):
    if shutil.disk_usage(config["BACKUP_DIR"]).free < sum(files.values()) + SPARE_BYTES:
        raise Failed("there is not enough free space to back up the database, nothing was changed")


def copy_plain(source, target):
    """Copies a regular file without following symlinks at either end, onto the disk before it returns."""
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise OSError(f"{source} is not a regular file")
        out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(out, "wb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            os.fchmod(writer.fileno(), stat.S_IMODE(info.st_mode))
            writer.flush()
            os.fsync(writer.fileno())


def back_up(config, data, current, line):
    """Copies the stopped server's database, with the image line it ran, to BACKUP_DIR/<time>-<version>/."""
    files = database_files(data)
    check_space(config, files)
    # UTC to the microsecond: sorts by age, and two runs never pick the same name.
    name = f"{datetime.datetime.now(datetime.timezone.utc):%Y%m%d-%H%M%S-%f}-{current}"
    folder = os.path.join(config["BACKUP_DIR"], name)
    os.makedirs(folder, mode=0o700)
    try:
        for each in files:
            copy_plain(os.path.join(data, each), os.path.join(folder, each))
        write_file(os.path.join(folder, "image.env"), f"{line}\n" if line is not None else "", 0o600)
        sync_folder(folder)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    prune(config, name)
    return folder


def prune(config, new):
    """Keeps the last KEEP_BACKUPS copies. The new one always stays, even when a clock that ran ahead gave an older
    one a later name (a Raspberry Pi has no clock of its own until it reaches a time server)."""
    try:
        older = sorted(
            name
            for name in os.listdir(config["BACKUP_DIR"])
            if name != new
            and BACKUP_NAME.fullmatch(name)
            and stat.S_ISDIR(os.lstat(os.path.join(config["BACKUP_DIR"], name)).st_mode)
        )
    except OSError as error:
        log(f"old copies were not removed: {error}")
        return
    for name in older[: max(len(older) - (KEEP_BACKUPS - 1), 0)]:
        shutil.rmtree(os.path.join(config["BACKUP_DIR"], name), ignore_errors=True)


def restore(data, folder):
    """Puts the copied database back, owned like the volume's folder, whatever is in its place now.

    The copy is checked first: a database file missing from it never removes the one in the volume.
    """
    saved = {}
    for name in DATABASE_FILES:
        try:
            info = os.lstat(os.path.join(folder, name))
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(info.st_mode):
            raise OSError(f"{name} in {folder} is not a regular file")
        saved[name] = info
    if DATABASE_FILES[0] not in saved:
        raise OSError(f"{folder} has no {DATABASE_FILES[0]}")
    owner = os.stat(data)
    for name in DATABASE_FILES:
        target = os.path.join(data, name)
        try:
            if stat.S_ISDIR(os.lstat(target).st_mode):
                shutil.rmtree(target)
            elif name not in saved:
                os.unlink(target)
        except FileNotFoundError:
            pass
        if name not in saved:
            continue
        handle, temporary = tempfile.mkstemp(dir=data, prefix=".restore-")
        try:
            source = os.open(os.path.join(folder, name), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(handle, "wb") as writer, os.fdopen(source, "rb") as reader:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
            os.chmod(temporary, stat.S_IMODE(saved[name].st_mode))
            os.chown(temporary, owner.st_uid, owner.st_gid)
            os.replace(temporary, target)
        except BaseException:
            remove(temporary)
            raise
    sync_folder(data)


def start(config):
    """Starts the server with the image the .env names now (never a build: one click runs published images only)."""
    return compose(config, "up", "-d", "--no-build", config["SERVICE"], check=False, timeout=UP_TIMEOUT).returncode == 0


def healthy(config):
    """Waits up to HEALTH_TIMEOUT seconds for the image's HEALTHCHECK (on /v1/health) to pass."""
    deadline = time.monotonic() + int(config["HEALTH_TIMEOUT"])
    while True:
        try:
            ids = compose(config, "ps", "-q", config["SERVICE"], check=False, timeout=60).stdout.split()
            if len(ids) == 1 and CONTAINER_ID.fullmatch(ids[0]):
                health = ["container", "inspect", "--format", "{{.State.Health.Status}}", ids[0]]
                found = run(config, *health, check=False, timeout=60)
                if found.returncode == 0 and found.stdout.strip() == "healthy":
                    return True
        except Failed:
            pass
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        time.sleep(min(3, left))


def attempt(what, action):
    """One rollback step: True when it worked. A failure is logged and the rollback goes on."""
    try:
        if action() is False:
            raise Failed("it did not succeed")
        return True
    except Exception as error:
        log(f"rollback: {what} failed: {error}")
        return False


def roll_back(config, status, switch, record, reason):
    """Brings back the previous image and its database. Every step is tried even when an earlier one failed."""
    # A stop request waits until this is over: stopped half-way, neither version would run.
    deferred = []
    previous = signal.signal(signal.SIGTERM, lambda signum, _: deferred.append(signum))
    try:
        service = config["SERVICE"]
        stopped = attempt("stopping the server", lambda: compose(config, "stop", service, timeout=STOP_TIMEOUT))
        database_back = record["folder"] is None or attempt(
            "putting the database back", lambda: restore(record["data"], record["folder"])
        )
        # A database the new version may have migrated stays with it: the previous version would refuse to open it.
        line = record["line"] if database_back else record["image"]
        env_back = attempt(
            "putting the image line back",
            lambda: write_file(config["ENV_FILE"], with_image(read_env(config["ENV_FILE"]), line)),
        )
        started = attempt("starting the server", lambda: start(config))
        # From here the server may take new notes: a later run must not put the copy back over them.
        switch.clear()
        if not database_back:
            status.write(
                "failed", f"the database could not be put back, so the new version was started again: {CHECK_THE_LOG}"
            )
        elif not (stopped and env_back and started):
            status.write("failed", f"the update could not be undone completely: {CHECK_THE_LOG}")
        elif not healthy(config):
            status.write(
                "rolled_back",
                f"{reason}; the previous version was started again but is not healthy yet: check the containers",
            )
        else:
            status.write("rolled_back", f"{reason}; the previous version is running again")
    finally:
        signal.signal(signal.SIGTERM, previous)
    if deferred and callable(previous):
        previous(deferred[0], None)


def switch_to(config, status, switch, current, reference, volume):
    """Stops the server, copies its database, runs `reference` and rolls back if it doesn't become healthy."""
    status.write("backing_up")
    env_text = read_env(config["ENV_FILE"])
    line = image_line(env_text)
    data = data_folder(config, volume)
    # Checked before anything stops; again once it has (the files may have grown).
    check_space(config, database_files(data))

    record = {
        "version": status.version,
        "current": current,
        "line": line,
        "image": f"FASTMEMO_IMAGE={reference}",
        "folder": None,
        "data": data,
        "verified": status.verified,
    }
    switch.save(record)
    try:
        compose(config, "stop", config["SERVICE"], timeout=STOP_TIMEOUT)
        record["folder"] = back_up(config, data, current, line)
    except BaseException as error:
        # Nothing changed yet: the running version just starts again.
        started = attempt("starting the server again", lambda: start(config))
        switch.clear()
        if not started:
            raise Failed(f"the database could not be copied and the server could not be started again: {CHECK_THE_LOG}")
        if isinstance(error, (Refused, Failed)):
            raise
        if isinstance(error, OSError):
            log(f"the copy failed: {error}")
            raise Failed("the database could not be backed up, nothing was changed")
        raise

    try:
        switch.save(record)
        status.write("restarting")
        write_file(config["ENV_FILE"], with_image(env_text, record["image"]))
        if start(config):
            if healthy(config):
                # The marker goes first: a power cut now must not undo a version that works.
                switch.clear()
                status.write("done")
                return
            reason = "the new version did not become healthy"
        else:
            reason = "the new version could not be started"
    except (Failed, OSError) as error:
        log(f"the switch failed: {error}")
        reason = "the new version could not be started"
    except BaseException:
        # Including the SystemExit a stop signal raises: the previous version comes back before leaving.
        if not isinstance(sys.exc_info()[1], SystemExit):
            traceback.print_exc()
        reason = "the update was interrupted"
    roll_back(config, status, switch, record, reason)


def update(config, status, switch):
    version = take_request(config["REQUEST_DIR"])
    if version is None:
        return
    status.version = version
    status.write("checking")

    container = running_container(config)
    current = refuse(config, container)
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
    switch_to(config, status, switch, current, reference, data_volume(container))


def recover(config, status, switch):
    """Undoes a switch a previous run couldn't finish (a power cut, a kill), before anything else."""
    record = switch.load()
    if record is None:
        return
    status.version = record["version"]
    status.verified = record["verified"]
    roll_back(config, status, switch, record, "the update was interrupted")


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
    # Once is enough: a second signal must not cut the rollback short.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(f"stopped by signal {signum}")


def main():
    config = load_config(os.environ.get("FASTMEMO_UPDATER_CONFIG", "/etc/fastmemo/updater.env"))
    signal.signal(signal.SIGTERM, stop_on_signal)
    status = Status(config["STATUS_DIR"])
    switch = Switch(config)
    os.makedirs(config["BACKUP_DIR"], mode=0o700, exist_ok=True)
    # One run at a time: the path unit and the boot run can start together.
    with open(os.path.join(config["BACKUP_DIR"], ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        recover(config, status, switch)
        if not os.path.lexists(os.path.join(config["REQUEST_DIR"], "request.json")):
            return
        cool_down(config)
        try:
            update(config, status, switch)
        except Refused as refusal:
            status.write("refused", str(refusal))
        except Failed as failure:
            status.write("failed", str(failure))
        except BaseException:
            # A rollback that was asked to stop half-way finishes first and has written its own final status.
            if not status.final:
                status.write("failed", f"the update stopped unexpectedly: {CHECK_THE_LOG}")
            raise


if __name__ == "__main__":
    main()
