// The dashboard. Reads /admin/api with the admin key (kept for this tab only). Everything the server returns is put in the
// page as text, never as HTML: device names come from the devices.

const KEY_STORAGE = "fastmemo-admin-key";
const REFRESH_MS = 10_000;

const $ = (id) => document.getElementById(id);

let key = sessionStorage.getItem(KEY_STORAGE) ?? "";
let timer = null;
let lastDriver = "sqlite";
let lastHistory = [];

/** An element with text (and attributes); children appended. */
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "text") node.textContent = String(value);
    else if (name === "class") node.className = value;
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  children.flat().forEach((child) => child && node.append(child));
  return node;
};

const svg = (tag, attrs = {}, text) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
};

const formatBytes = (bytes) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatNumber = (n) => new Intl.NumberFormat().format(n);

const ago = (time) => {
  const t = Number(time);
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

const duration = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

let toastTimer = null;
const toast = (message) => {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3500);
};

class AuthError extends Error {}

const api = async (method, path, { raw = false } = {}) => {
  const res = await fetch(`/admin/api${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401) throw new AuthError("Wrong key");
  if (res.status === 429) throw new AuthError("Too many attempts: wait a few minutes");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Request failed (${res.status})`);
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
};

/* --- Rendering --- */

const renderCards = (o) => {
  const cards = [
    ["Notes", formatNumber(o.counts.notes), formatBytes(o.counts.noteBytes)],
    ["Devices", `${o.counts.devices} / ${o.server.limits.maxDevices}`, "connected"],
    ["Categories", formatNumber(o.counts.categories), ""],
    ["Deleted notes", formatNumber(o.counts.tombstones), "kept to tell other devices"],
    ["Database", formatBytes(o.server.database.bytes), o.server.database.driver === "sqlite" ? "SQLite" : "PostgreSQL"],
    ["Memory", formatBytes(o.server.memoryBytes), `up ${duration(Date.now() - o.server.startedAt)}`],
  ];
  $("cards").replaceChildren(
    ...cards.map(([label, value, sub]) =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "stat-label", text: label }),
        el("div", { class: "stat-value", text: value }),
        sub ? el("div", { class: "stat-sub", text: sub }) : null
      )
    )
  );
};

const SERIES = [
  ["reads", "Reads"],
  ["writes", "Writes"],
  ["deletes", "Deletes"],
];

const renderChart = (history) => {
  $("legend").replaceChildren(...SERIES.map(([k, label]) => el("span", {}, el("span", { class: `swatch ${k}` }), label)));

  // Drawn at the box's real width: a stretched viewBox would stretch the text too.
  const width = Math.max(280, $("chart").clientWidth);
  const height = 200;
  const pad = { top: 10, right: 8, bottom: 22, left: 44 };
  // A round top, so the four steps of the axis are round numbers too.
  const peak = Math.max(1, ...history.flatMap((d) => SERIES.map(([k]) => d[k])));
  const magnitude = 10 ** Math.floor(Math.log10(peak / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s * 4 >= peak && Number.isInteger(s)) ?? 10 * magnitude;
  const max = step * 4;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / history.length;
  const gap = slot > 16 ? 4 : 2;
  const barW = Math.max(1.5, (slot - gap) / SERIES.length);
  // Days labelled counting back from today (always labelled), spaced to fit the width.
  const every = width < 520 ? 7 : 5;

  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height });
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH * i) / 4;
    root.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: "grid" }));
    root.append(svg("text", { x: pad.left - 6, y: y + 3, "text-anchor": "end", class: "axis" }, formatNumber(max - step * i)));
  }
  history.forEach((day, i) => {
    const x0 = pad.left + i * slot + gap / 2;
    SERIES.forEach(([k, label], j) => {
      const h = (day[k] / max) * plotH;
      const rect = svg("rect", {
        x: x0 + j * barW,
        y: pad.top + plotH - h,
        width: Math.max(1, barW - 1),
        height: Math.max(h, day[k] ? 1 : 0),
        rx: 1.5,
        class: k,
      });
      rect.append(svg("title", {}, `${day.day} · ${label}: ${formatNumber(day[k])}`));
      root.append(rect);
    });
    if ((history.length - 1 - i) % every === 0) {
      const last = i === history.length - 1;
      const x = last ? width - pad.right : x0 + slot / 2;
      root.append(svg("text", { x, y: height - 6, "text-anchor": last ? "end" : "middle", class: "axis" }, day.day.slice(5)));
    }
  });
  $("chart").replaceChildren(root);

  const today = history[history.length - 1] ?? {};
  const sum = (k) => history.reduce((n, d) => n + d[k], 0);
  const count = (n, one, many) => [el("b", { text: formatNumber(n ?? 0) }), ` ${n === 1 ? one : many}`];
  const line = (label, parts) => el("span", {}, `${label}: `, ...parts.flatMap((part, i) => (i > 0 ? [" · ", ...part] : part)));
  $("totals").replaceChildren(
    line("Today", [
      count(today.reads, "read", "reads"),
      count(today.writes, "write", "writes"),
      count(today.deletes, "delete", "deletes"),
    ]),
    line(`${history.length} days`, [
      count(sum("requests"), "request", "requests"),
      [el("b", { text: formatBytes(sum("bytesIn") + sum("bytesOut")) }), " traffic"],
      count(sum("errors"), "error", "errors"),
      count(sum("authFailures"), "wrong key", "wrong keys"),
    ])
  );
};

const renderDevices = (devices) => {
  const body = $("devices");
  if (devices.length === 0) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: 6, class: "empty", text: "No device connected yet." })));
    return;
  }
  body.replaceChildren(
    ...devices.map((d) => {
      const fresh = d.presence && Date.now() - d.presence.at < 10 * 60 * 1000 && d.presence.noteId;
      const fullSync = el("button", {
        class: "ghost small-button",
        type: "button",
        text: d.fullSyncDue ? "Full sync asked" : "Full sync",
        disabled: !!d.fullSyncDue,
      });
      fullSync.addEventListener("click", () =>
        action(`/devices/${encodeURIComponent(d.uuid)}/full-sync`, "POST", "Full sync asked")
      );
      const remove = el("button", { class: "danger small-button", type: "button", text: "Remove" });
      remove.addEventListener("click", () => {
        if (confirm(`Remove "${d.modelName}"? It stops syncing at once and has to connect again.`)) {
          action(`/devices/${encodeURIComponent(d.uuid)}`, "DELETE", "Device removed");
        }
      });
      return el(
        "tr",
        {},
        el(
          "td",
          {},
          el("div", { class: "device-name", text: `${d.modelName} · ${d.brand}` }),
          el("div", { class: "device-id", text: d.uuid })
        ),
        el("td", { text: ago(d.lastSync) }),
        el("td", { text: ago(d.lastSeen) }),
        el("td", {}, el("span", { class: `pill ${fresh ? "ok" : ""}`, text: fresh ? "Editing" : "—" })),
        el(
          "td",
          {},
          el("span", {
            class: `pill ${d.behind > 0 ? "warn" : "ok"}`,
            text: d.behind > 0 ? formatNumber(d.behind) : "Up to date",
          })
        ),
        el("td", {}, el("div", { class: "row-actions" }, fullSync, remove))
      );
    })
  );
};

const renderFacts = (o) => {
  const facts = [
    ["Version", o.server.version],
    ["Instance", o.server.instance],
    ["Node.js", o.server.node],
    ["Platform", o.server.platform],
    ["Max note size", formatBytes(o.server.limits.maxNoteBytes)],
    ["Max request", formatBytes(o.server.limits.maxBodyBytes)],
    ["Changes so far", formatNumber(o.seq)],
  ];
  $("facts").replaceChildren(...facts.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
  $("server-line").textContent =
    `v${o.server.version} · ${o.server.database.driver === "sqlite" ? "SQLite" : "PostgreSQL"} · up ${duration(Date.now() - o.server.startedAt)}`;
};

const renderEvents = (events) => {
  const list = $("events");
  if (events.length === 0) {
    list.replaceChildren(el("li", { class: "empty", text: "Nothing to report." }));
    return;
  }
  list.replaceChildren(
    ...events.map((e) =>
      el(
        "li",
        {},
        el("time", { datetime: new Date(e.at).toISOString(), text: new Date(e.at).toLocaleString() }),
        el("span", { class: `level ${e.level}`, text: e.level }),
        el(
          "div",
          {},
          el("div", { text: e.message }),
          e.detail ? el("div", { class: "event-detail", text: JSON.stringify(e.detail) }) : null
        )
      )
    )
  );
};

const renderBackup = (driver) => {
  lastDriver = driver;
  const sqlite = driver === "sqlite";
  $("backup-text").textContent = sqlite
    ? "A consistent copy of the whole database (one .db file). The notes in it stay encrypted. To restore: stop the server, put the file in place of fastmemo.db in the data folder, start it, then ask every device for a full sync."
    : "This server uses PostgreSQL: back it up with pg_dump (see the README).";
  $("backup").disabled = !sqlite;
};

/* --- Flow --- */

const setOnline = (online) => {
  $("status").classList.toggle("offline", !online);
  $("status-text").textContent = online ? "Online" : "Unreachable";
};

const load = async () => {
  try {
    const o = await api("GET", "/overview");
    setOnline(true);
    renderCards(o);
    lastHistory = o.history;
    renderChart(o.history);
    renderDevices(o.devices);
    renderFacts(o);
    renderEvents(o.events);
    renderBackup(o.server.database.driver);
    return true;
  } catch (e) {
    if (e instanceof AuthError) {
      logout(e.message);
      return false;
    }
    setOnline(false);
    return false;
  }
};

const action = async (path, method, done) => {
  try {
    await api(method, path);
    toast(done);
  } catch (e) {
    toast(e.message);
  }
  load();
};

const start = async () => {
  $("login").hidden = true;
  $("app").hidden = false;
  if (await load()) {
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }
};

const logout = (message) => {
  clearInterval(timer);
  key = "";
  sessionStorage.removeItem(KEY_STORAGE);
  $("app").hidden = true;
  $("login").hidden = false;
  const error = $("login-error");
  error.textContent = message ?? "";
  error.hidden = !message;
  $("key").value = "";
  $("key").focus();
};

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  key = $("key").value.trim();
  try {
    await api("GET", "/overview");
    sessionStorage.setItem(KEY_STORAGE, key);
    $("login-error").hidden = true;
    start();
  } catch (e) {
    const error = $("login-error");
    error.textContent = e instanceof AuthError ? e.message : "The server didn't answer";
    error.hidden = false;
  }
});

$("refresh").addEventListener("click", () => load());
let resizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => lastHistory.length > 0 && renderChart(lastHistory));
});
$("logout").addEventListener("click", () => logout());
$("full-sync-all").addEventListener("click", () => {
  if (confirm("Ask every device to compare all its notes with the server's on its next sync?")) {
    action("/full-sync", "POST", "Every device will run a full sync");
  }
});
$("backup").addEventListener("click", async () => {
  if (lastDriver !== "sqlite") return;
  const button = $("backup");
  button.disabled = true;
  try {
    const res = await api("GET", "/backup", { raw: true });
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "fastmemo-backup.db";
    const url = URL.createObjectURL(await res.blob());
    const link = el("a", { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast("Backup downloaded");
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
});

if (key) start();
else logout();
