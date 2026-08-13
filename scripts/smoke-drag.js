/**
 * Smoke-test: native grip drag + click-through policy.
 * Run: npx electron scripts/smoke-drag.js
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
} = require("electron");
const path = require("path");

/** @type {BrowserWindow | null} */
let win = null;
let windowMoving = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let moveIdleTimer = null;
let ignoreState = true;

function fail(msg) {
  console.error(`[smoke-drag] FAIL: ${msg}`);
  app.exit(1);
}

function pass(msg) {
  console.log(`[smoke-drag] OK: ${msg}`);
}

function markWindowMoving() {
  windowMoving = true;
  if (moveIdleTimer != null) clearTimeout(moveIdleTimer);
  moveIdleTimer = setTimeout(() => {
    windowMoving = false;
    moveIdleTimer = null;
    if (!win || win.isDestroyed()) return;
    ignoreState = true;
    win.setIgnoreMouseEvents(true, { forward: true });
  }, 200);
}

function applyMouseIgnore(ignore) {
  if (!win || win.isDestroyed()) return false;
  if (ignore && windowMoving) return false;
  ignoreState = !!ignore;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
  return true;
}

ipcMain.on("set-mouse-ignore", (_event, ignore) => {
  applyMouseIgnore(!!ignore);
});

ipcMain.handle("get-state", () => ({
  sessions: [],
  theme: "minimal",
  summary: { total: 0, working: 0, done: 0, error: 0, idle: 0, overall: "idle" },
  at: Date.now(),
}));
ipcMain.handle("focus-cursor", async () => ({ ok: true }));
ipcMain.on("hide-window", () => {});
ipcMain.on("clear-finished", () => {});
ipcMain.on("quit-app", () => app.quit());

async function run() {
  const display = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 120,
    height: 100,
    x: display.x + 80,
    y: display.y + 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.on("will-move", markWindowMoving);
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 400));

  const region = await win.webContents.executeJavaScript(`
    (() => {
      const grip = document.querySelector("#signal .grip");
      const signal = document.querySelector("#signal");
      if (!grip || !signal) return null;
      const g = getComputedStyle(grip).webkitAppRegion || getComputedStyle(grip).getPropertyValue("-webkit-app-region");
      const s = getComputedStyle(signal).webkitAppRegion || getComputedStyle(signal).getPropertyValue("-webkit-app-region");
      return { grip: String(g).trim(), signal: String(s).trim() };
    })()
  `);
  if (!region) return fail("missing signal/grip");
  if (region.grip !== "drag") return fail(`grip region should be drag, got "${region.grip}"`);
  if (region.signal === "drag") return fail("signal should not be drag");
  pass(`regions grip=${region.grip} signal=${region.signal || "no-drag"}`);

  // Hover enables hit-testing.
  await win.webContents.executeJavaScript(
    `window.cursorDot.setMouseIgnore(false)`
  );
  await new Promise((r) => setTimeout(r, 30));
  if (ignoreState !== false) return fail("hover did not disable ignore");
  pass("hover enables hit-testing");

  // Simulate OS drag start (will-move); mouseleave must not punch through.
  markWindowMoving();
  const blocked = applyMouseIgnore(true);
  if (blocked) return fail("ignore=true should be blocked during will-move");
  if (ignoreState !== false) return fail("ignore flipped during move");
  pass("ignore blocked during native move");

  // Move window with OS API (same path as app-region drag) — must not drift alone.
  const [x0, y0] = win.getPosition();
  win.setPosition(x0 + 40, y0 + 25);
  await new Promise((r) => setTimeout(r, 50));
  const [x1, y1] = win.getPosition();
  if (Math.abs(x1 - (x0 + 40)) > 2 || Math.abs(y1 - (y0 + 25)) > 2) {
    return fail(`setPosition unstable: (${x0},${y0}) -> (${x1},${y1})`);
  }
  pass("single setPosition is stable");

  // After idle, click-through restores.
  await new Promise((r) => setTimeout(r, 250));
  if (windowMoving) return fail("windowMoving stuck true");
  if (ignoreState !== true) return fail("click-through not restored after move idle");
  pass("click-through restored after move idle");

  // No continuous polling: position stays put when idle.
  const [xf, yf] = win.getPosition();
  await new Promise((r) => setTimeout(r, 300));
  const [xs, ys] = win.getPosition();
  if (xs !== xf || ys !== yf) {
    return fail(`idle drift (${xf},${yf}) -> (${xs},${ys})`);
  }
  pass("no idle drift");

  console.log("[smoke-drag] ALL PASSED");
  try {
    if (moveIdleTimer != null) clearTimeout(moveIdleTimer);
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    // ignore
  }
  app.exit(0);
}

app.whenReady().then(() => {
  run().catch((err) => fail(String(err && err.stack ? err.stack : err)));
});

app.on("window-all-closed", (e) => e.preventDefault());
