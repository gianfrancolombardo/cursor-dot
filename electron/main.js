const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
} = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// Packaged / GUI launches often have no console. Logging then hits EPIPE and
// Electron shows an uncaught-exception dialog even when the action succeeded.
function isBrokenPipe(err) {
  return Boolean(err && (err.code === "EPIPE" || err.code === "EIO"));
}

function ignoreBrokenPipe(stream) {
  if (!stream || typeof stream.on !== "function") return;
  stream.on("error", (err) => {
    if (isBrokenPipe(err)) return;
  });
}
ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

function safeLog(...args) {
  try {
    console.log(...args);
  } catch (err) {
    if (!isBrokenPipe(err)) throw err;
  }
}

function safeError(...args) {
  try {
    console.error(...args);
  } catch (err) {
    if (!isBrokenPipe(err)) throw err;
  }
}

function parseHookCli() {
  if (process.argv.includes("--uninstall-hooks")) return "uninstall";
  if (process.argv.includes("--install-hooks")) return "install";
  return null;
}

function loadHooksManager() {
  return require(path.join(__dirname, "..", "scripts", "hooks-manager"));
}

const HOOK_CLI = parseHookCli();

const PORT = Number(process.env.CURSOR_DOT_PORT || 17373);
const STATE_PATH = path.join(app.getPath("userData"), "sessions.json");
const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const EVENTS_DIR = path.join(require("os").homedir(), ".cursor", "cursor-dot");
const EVENTS_FILE = path.join(EVENTS_DIR, "events.jsonl");
/** Drop persisted sessions older than this. */
const SESSION_TTL_MS = 5 * 60 * 60 * 1000;
/** Overlay only lists sessions updated within this window. */
const DISPLAY_WINDOW_MS = 5 * 60 * 60 * 1000;
/** Hard cap on dots shown in the overlay. */
const MAX_VISIBLE_DOTS = 8;
let eventsOffset = 0;

/** @type {{ theme: "minimal" | "glass" }} */
let settings = { theme: "minimal" };

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {http.Server | null} */
let server = null;

/** @type {Map<string, object>} */
const sessions = new Map();

/** True while the OS is moving the frameless window (native app-region drag). */
let windowMoving = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let moveIdleTimer = null;

function markWindowMoving() {
  windowMoving = true;
  if (moveIdleTimer != null) clearTimeout(moveIdleTimer);
  // will-move repeats during drag; settle shortly after the last event.
  moveIdleTimer = setTimeout(() => {
    windowMoving = false;
    moveIdleTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Restore click-through; next hover on the pill re-enables hit-testing.
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }, 200);
}

function loadPersisted() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (item && item.conversationId) {
        sessions.set(item.conversationId, item);
      }
    }
  } catch {
    // ignore corrupt state
  }
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return;
    if (raw.theme === "glass" || raw.theme === "minimal") {
      settings.theme = raw.theme;
    }
  } catch {
    // ignore
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function setTheme(theme) {
  if (theme !== "minimal" && theme !== "glass") return;
  if (settings.theme === theme) return;
  settings.theme = theme;
  persistSettings();
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcast();
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify([...sessions.values()], null, 2),
      "utf8"
    );
  } catch {
    // ignore
  }
}

function pruneExpired(now = Date.now()) {
  let changed = false;
  for (const [id, s] of sessions) {
    const updatedAt = Number(s.updatedAt) || 0;
    if (!updatedAt || now - updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      changed = true;
    }
  }
  return changed;
}

function visibleSessions(now = Date.now()) {
  return [...sessions.values()]
    .filter((s) => {
      const updatedAt = Number(s.updatedAt) || 0;
      return updatedAt > 0 && now - updatedAt <= DISPLAY_WINDOW_MS;
    })
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, MAX_VISIBLE_DOTS);
}

function snapshot() {
  pruneExpired();
  const list = visibleSessions();
  const working = list.filter((s) => s.status === "working").length;
  const done = list.filter((s) => s.status === "done").length;
  const error = list.filter((s) => s.status === "error").length;
  const idle = list.filter((s) => s.status === "idle").length;
  return {
    sessions: list,
    theme: settings.theme,
    summary: {
      total: list.length,
      working,
      done,
      error,
      idle,
      overall:
        working > 0 ? "working" : error > 0 ? "error" : done > 0 ? "done" : "idle",
    },
    at: Date.now(),
  };
}

function fitWindow(sessionCount) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Avoid fighting the OS drag / live move on scaled displays.
  if (windowMoving) return;

  const n = Math.max(0, Number(sessionCount) || 0);
  // Left gutter for hover tip; keep narrow so less dead transparent area.
  const winWidth = 190;
  const dots = Math.max(n, 1);
  const signalPadY = 18;
  const gripH = 19;
  const contentH = dots * 14 + Math.max(0, dots - 1) * 8;
  const shadowPad = 12 + 14; // matches body padding top+bottom
  const winHeight = shadowPad + signalPadY + gripH + contentH;

  const bounds = mainWindow.getBounds();
  const right = bounds.x + bounds.width;
  mainWindow.setBounds({
    x: right - winWidth,
    y: bounds.y,
    width: winWidth,
    height: winHeight,
  });
}

function broadcast() {
  const data = snapshot();
  persist();
  fitWindow(data.summary.total);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state", data);
  }
  updateTray(data);
  return data;
}

function applyEvent(event, { silent = false } = {}) {
  if (!event || event.type !== "agent") return silent ? null : snapshot();

  const id = event.conversationId;
  if (!id) return silent ? null : snapshot();

  if (event.status === "gone" || event.event === "sessionEnd") {
    sessions.delete(id);
    return silent ? true : broadcast();
  }

  const prev = sessions.get(id) || {};
  const next = {
    conversationId: id,
    label: event.label || prev.label || "workspace",
    status: event.status || prev.status || "idle",
    model: event.model || prev.model || null,
    workspaceRoots: event.workspaceRoots || prev.workspaceRoots || [],
    generationId: event.generationId || prev.generationId || null,
    promptPreview: event.promptPreview || prev.promptPreview || null,
    lastEvent: event.event,
    stopStatus: event.stopStatus || null,
    updatedAt: event.at || Date.now(),
    startedAt: prev.startedAt || event.at || Date.now(),
  };

  // Keep working sticky until stop/sessionEnd; thought/tool events refresh timestamp.
  if (
    prev.status === "working" &&
    (event.status === "working" || event.status === "idle") &&
    event.event !== "stop"
  ) {
    next.status = "working";
  }

  sessions.set(id, next);
  return silent ? true : broadcast();
}

function drainEventsFile() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const stat = fs.statSync(EVENTS_FILE);
    if (stat.size < eventsOffset) eventsOffset = 0;
    if (stat.size === eventsOffset) return;

    const fd = fs.openSync(EVENTS_FILE, "r");
    const length = stat.size - eventsOffset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, eventsOffset);
    fs.closeSync(fd);
    eventsOffset = stat.size;

    const chunk = buffer.toString("utf8");
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    let changed = false;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (applyEvent(event, { silent: true })) changed = true;
      } catch {
        // skip bad lines
      }
    }
    if (changed) broadcast();
  } catch (err) {
    console.error("[cursor-dot] events drain error:", err.message);
  }
}

function watchEventsFile() {
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "", "utf8");
    eventsOffset = fs.statSync(EVENTS_FILE).size;
    // Only consume new events while the app is alive (avoid replaying history).
    fs.watch(EVENTS_FILE, { persistent: true }, () => {
      drainEventsFile();
    });
    setInterval(drainEventsFile, 1000);
  } catch (err) {
    console.error("[cursor-dot] events watch error:", err.message);
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const winWidth = 190;
  const winHeight = 100;
  const margin = 16;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: width - winWidth - margin,
    y: Math.round((height - winHeight) / 2),
    title: "Cursor Dot",
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Pass clicks through transparent chrome; pill re-enables hit-testing on hover.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  // Native OS drag (app-region) emits will-move; keep hit-testing until it settles.
  mainWindow.on("will-move", markWindowMoving);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function loadAppIcon() {
  const candidates = [
    path.join(__dirname, "..", "assets", "tray-32.png"),
    path.join(__dirname, "..", "assets", "icon.png"),
    path.join(__dirname, "..", "assets", "tray-16.png"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    } catch {
      // try next
    }
  }
  // Fallback: solid amber circle (never blank in the tray).
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR4nO2VMQ6AMAwD7/9fOgYWKpQ2TRuG3EkMVhxZckJERERExP8wA9bABdgH9gG4A5fA2s5cA/fAIzB2zjPwCrwDY+e8Am/AJ7B2zi/wA/wFa+f8A7/AX7B2ThERERER8Q8+QF0Jf6Jf3gEAAAAASUVORK5CYII=",
    "base64"
  );
  return nativeImage.createFromBuffer(png);
}

function trayIcon() {
  const base = loadAppIcon();
  const sized = base.resize({ width: 16, height: 16 });
  return sized.isEmpty() ? base : sized;
}

function updateTray(data) {
  if (!tray) return;
  const s = data.summary;
  tray.setToolTip(
    `Cursor Dot · ${s.working} generando · ${s.done} terminado · ${s.total} total`
  );
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Mostrar overlay",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: "Limpiar terminados",
      click: () => {
        for (const [id, s] of sessions) {
          if (s.status === "done" || s.status === "idle" || s.status === "error") {
            sessions.delete(id);
          }
        }
        broadcast();
      },
    },
    { type: "separator" },
    {
      label: "Apariencia",
      submenu: [
        {
          label: "Minimalista",
          type: "radio",
          checked: settings.theme === "minimal",
          click: () => setTheme("minimal"),
        },
        {
          label: "Glass",
          type: "radio",
          checked: settings.theme === "glass",
          click: () => setTheme("glass"),
        },
      ],
    },
    { type: "separator" },
    {
      label: "Salir",
      click: () => app.quit(),
    },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (!mainWindow) createWindow();
    else if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
  updateTray(snapshot());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function startServer() {
  server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, port: PORT }));
        return;
      }

      if (req.method === "GET" && req.url === "/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snapshot()));
        return;
      }

      if (req.method === "POST" && req.url === "/event") {
        const event = await readBody(req);
        const state = applyEvent(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, summary: state.summary }));
        return;
      }

      if (req.method === "POST" && req.url === "/clear") {
        sessions.clear();
        const state = broadcast();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[cursor-dot] listening on http://127.0.0.1:${PORT}`);
  });

  server.on("error", (err) => {
    console.error("[cursor-dot] server error:", err.message);
  });
}

/**
 * Warm PowerShell worker: compiles Win32 helpers once, then focuses by project.
 * Avoids ETIMEDOUT from cold Add-Type on every click.
 */
/** @type {import("child_process").ChildProcessWithoutNullStreams | null} */
let focusWorker = null;
/** @type {string} */
let focusStdoutBuf = "";
/** @type {Array<{ resolve: (v: object) => void, timer: NodeJS.Timeout }>} */
const focusWaiters = [];

function settleFocusWaiter(result) {
  const waiter = focusWaiters.shift();
  if (!waiter) return;
  clearTimeout(waiter.timer);
  waiter.resolve(result);
}

function stopFocusWorker() {
  while (focusWaiters.length) {
    settleFocusWaiter({ ok: false, reason: "worker_stopped" });
  }
  if (!focusWorker) return;
  try {
    focusWorker.stdin.write("quit\n");
  } catch {
    // ignore
  }
  try {
    focusWorker.kill();
  } catch {
    // ignore
  }
  focusWorker = null;
  focusStdoutBuf = "";
}

function resolveFocusWorkerScript() {
  // PowerShell cannot execute a .ps1 packed inside app.asar.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "focus-cursor-worker.ps1");
  }
  return path.join(__dirname, "focus-cursor-worker.ps1");
}

function ensureFocusWorker() {
  if (focusWorker && !focusWorker.killed) return focusWorker;

  const scriptPath = resolveFocusWorkerScript();
  if (!fs.existsSync(scriptPath)) {
    safeError("[cursor-dot] focus worker missing:", scriptPath);
    return null;
  }

  focusStdoutBuf = "";
  focusWorker = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  focusWorker.stdout.setEncoding("utf8");
  focusWorker.stdout.on("data", (chunk) => {
    focusStdoutBuf += chunk;
    let idx;
    while ((idx = focusStdoutBuf.indexOf("\n")) >= 0) {
      const line = focusStdoutBuf.slice(0, idx).replace(/\r$/, "");
      focusStdoutBuf = focusStdoutBuf.slice(idx + 1);
      if (!line || line === "ready") continue;
      safeLog("[cursor-dot] focus Cursor:", line);
      settleFocusWaiter({
        ok: line.startsWith("ok"),
        detail: line,
      });
    }
  });

  focusWorker.stderr.setEncoding("utf8");
  focusWorker.stderr.on("data", (chunk) => {
    safeError("[cursor-dot] focus worker:", String(chunk).trim());
  });

  focusWorker.on("exit", () => {
    focusWorker = null;
    while (focusWaiters.length) {
      settleFocusWaiter({ ok: false, reason: "worker_exit" });
    }
  });

  return focusWorker;
}

function focusCursorWindow(projectLabel) {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, reason: "not_win32" });
  }

  // Empty / generic labels still try Cursor Agents (Agent Window has no project in title).
  const project = String(projectLabel || "").trim() || "__agents__";

  const worker = ensureFocusWorker();
  if (!worker) {
    return Promise.resolve({ ok: false, reason: "worker_missing" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = focusWaiters.findIndex((w) => w.resolve === resolve);
      if (i >= 0) focusWaiters.splice(i, 1);
      resolve({ ok: false, reason: "timeout" });
    }, 8000);

    focusWaiters.push({ resolve, timer });
    try {
      worker.stdin.write(`${project}\n`);
    } catch (err) {
      settleFocusWaiter({ ok: false, reason: String(err.message || err) });
    }
  });
}

ipcMain.handle("get-state", () => snapshot());
ipcMain.handle("focus-cursor", (_event, projectLabel) =>
  focusCursorWindow(projectLabel)
);

ipcMain.on("hide-window", () => {
  if (mainWindow) mainWindow.hide();
});
ipcMain.on("set-mouse-ignore", (_event, ignore) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // mouseleave fires at drag start — do not punch through mid-drag.
  if (ignore && windowMoving) return;
  if (ignore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
  else mainWindow.setIgnoreMouseEvents(false);
});
ipcMain.on("clear-finished", () => {
  for (const [id, s] of sessions) {
    if (s.status !== "working") sessions.delete(id);
  }
  broadcast();
});
ipcMain.on("quit-app", () => app.quit());

function syncPackagedHooks() {
  if (!app.isPackaged) return;
  try {
    const hooks = loadHooksManager();
    const result = hooks.ensureHooks({
      version: app.getVersion(),
      runnerExe: process.execPath,
    });
    if (result.installed) {
      console.log(
        `[cursor-dot] hooks ${result.reason}: v${result.version}`
      );
    }
  } catch (err) {
    console.error("[cursor-dot] hook sync failed:", err.message);
  }
}

function startOverlay() {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.cursordot.app");
    ensureFocusWorker();
  }
  syncPackagedHooks();
  loadSettings();
  loadPersisted();
  pruneExpired();
  startServer();
  watchEventsFile();
  createWindow();
  createTray();
  fitWindow(sessions.size);
  setInterval(() => {
    if (pruneExpired()) broadcast();
  }, 30_000);
}

if (HOOK_CLI) {
  app.whenReady().then(() => {
    try {
      const hooks = loadHooksManager();
      if (HOOK_CLI === "install") {
        const result = hooks.installHooks({
          version: app.getVersion(),
          runnerExe: process.execPath,
        });
        console.log(
          `[cursor-dot] hooks installed v${result.version} -> ${result.command}`
        );
      } else {
        hooks.uninstallHooks();
        console.log("[cursor-dot] hooks uninstalled");
      }
      app.exit(0);
    } catch (err) {
      console.error(`[cursor-dot] hook ${HOOK_CLI} failed:`, err.message);
      app.exit(1);
    }
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    app.whenReady().then(startOverlay);

    app.on("window-all-closed", (e) => {
      e.preventDefault();
    });

    app.on("before-quit", () => {
      if (moveIdleTimer != null) clearTimeout(moveIdleTimer);
      stopFocusWorker();
      persist();
      if (server) server.close();
    });
  }
}
