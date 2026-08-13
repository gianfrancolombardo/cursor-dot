#!/usr/bin/env node
/**
 * Shared Cursor Dot hooks installer/uninstaller.
 * Works from npm (dev) and from the packaged Windows app.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const MARKER = "cursor-dot";
const LEGACY_MARKER = "cursor-dash";
const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const HOOKS_DIR = path.join(CURSOR_DIR, "hooks");
const HOOKS_JSON = path.join(CURSOR_DIR, "hooks.json");
const DATA_DIR = path.join(CURSOR_DIR, "cursor-dot");
const INSTALL_META = path.join(DATA_DIR, "install-meta.json");
const RELAY_DST = path.join(HOOKS_DIR, "cursor-dot-relay.js");
const RELAY_CMD = path.join(HOOKS_DIR, "cursor-dot-relay.cmd");
const LEGACY_RELAY_DST = path.join(HOOKS_DIR, "cursor-dash-relay.js");
const LEGACY_CMD = path.join(HOOKS_DIR, "cursor-dash-relay.cmd");

const EVENTS = ["beforeSubmitPrompt", "stop", "sessionEnd"];

const RELAY_FILES = [
  RELAY_DST,
  RELAY_CMD,
  LEGACY_RELAY_DST,
  LEGACY_CMD,
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function loadHooksJson() {
  if (!fs.existsSync(HOOKS_JSON)) {
    return { version: 1, hooks: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
    if (!parsed.hooks || typeof parsed.hooks !== "object") {
      parsed.hooks = {};
    }
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch (err) {
    throw new Error(`Could not parse ${HOOKS_JSON}: ${err.message}`);
  }
}

function isOurs(entry) {
  if (!entry || typeof entry !== "object") return false;
  const cmd = String(entry.command || "");
  return (
    cmd.includes("cursor-dot-relay") ||
    cmd.includes("cursor-dash-relay") ||
    cmd.includes(MARKER) ||
    cmd.includes(LEGACY_MARKER)
  );
}

function stripOurs(config) {
  for (const [event, list] of Object.entries(config.hooks)) {
    if (!Array.isArray(list)) continue;
    config.hooks[event] = list.filter((entry) => !isOurs(entry));
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveAppRoot() {
  if (process.resourcesPath) {
    return path.dirname(process.resourcesPath);
  }
  return path.join(__dirname, "..");
}

function resolveRelaySource() {
  const appRoot = resolveAppRoot();
  return firstExisting([
    process.resourcesPath
      ? path.join(process.resourcesPath, "hooks", "relay.js")
      : null,
    path.join(appRoot, "resources", "hooks", "relay.js"),
    path.join(appRoot, "hooks", "relay.js"),
    path.join(__dirname, "..", "hooks", "relay.js"),
  ]);
}

function resolvePackageVersion(explicitVersion) {
  if (explicitVersion) return String(explicitVersion);

  const pkgCandidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, "app.asar.unpacked", "package.json")
      : null,
    path.join(resolveAppRoot(), "resources", "app.asar.unpacked", "package.json"),
    path.join(resolveAppRoot(), "package.json"),
    path.join(__dirname, "..", "package.json"),
  ];

  const pkgPath = firstExisting(pkgCandidates);
  if (!pkgPath) return "0.0.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/**
 * Prefer Electron-as-Node for packaged apps so end users do not need Node.js.
 * Fall back to system Node in development.
 */
function resolveRunner(options = {}) {
  const forced = options.runnerExe && String(options.runnerExe).trim();
  if (forced && fs.existsSync(forced)) {
    const base = path.basename(forced).toLowerCase();
    const useElectronAsNode = !base.includes("node");
    return { exe: forced, useElectronAsNode };
  }

  const execPath = process.execPath;
  const base = path.basename(execPath).toLowerCase();
  const looksLikeNode = base === "node.exe" || base === "node";
  const looksLikeElectron =
    base.includes("electron") ||
    base.includes("cursor dot") ||
    base.includes("cursor-dot") ||
    Boolean(process.versions.electron);

  if (looksLikeElectron && !looksLikeNode) {
    return { exe: execPath, useElectronAsNode: true };
  }

  if (looksLikeNode) {
    return { exe: execPath, useElectronAsNode: false };
  }

  return { exe: "node", useElectronAsNode: false };
}

function writeCmdWrapper(runner) {
  const lines = ["@echo off"];
  if (runner.useElectronAsNode) {
    lines.push("set ELECTRON_RUN_AS_NODE=1");
  }
  lines.push(`"${runner.exe}" "%~dp0cursor-dot-relay.js"`);
  lines.push("");
  fs.writeFileSync(RELAY_CMD, `${lines.join("\r\n")}`, "utf8");
}

function readInstallMeta() {
  try {
    if (!fs.existsSync(INSTALL_META)) return null;
    return JSON.parse(fs.readFileSync(INSTALL_META, "utf8"));
  } catch {
    return null;
  }
}

function writeInstallMeta(meta) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(INSTALL_META, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function hooksSeemInstalled(runner) {
  if (!fs.existsSync(RELAY_DST) || !fs.existsSync(HOOKS_JSON)) return false;
  if (process.platform === "win32" && !fs.existsSync(RELAY_CMD)) return false;

  try {
    const config = loadHooksJson();
    const hasHook = EVENTS.some((event) => {
      const list = config.hooks[event];
      return Array.isArray(list) && list.some(isOurs);
    });
    if (!hasHook) return false;

    if (process.platform === "win32" && runner?.exe) {
      const cmdBody = fs.readFileSync(RELAY_CMD, "utf8");
      if (!cmdBody.includes(runner.exe)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function installHooks(options = {}) {
  const relaySrc = resolveRelaySource();
  if (!relaySrc) {
    throw new Error(
      "Could not find hooks/relay.js. Reinstall Cursor Dot or run from the project root."
    );
  }

  const version = resolvePackageVersion(options.version);
  const runner = resolveRunner(options);

  ensureDir(HOOKS_DIR);
  fs.copyFileSync(relaySrc, RELAY_DST);
  removeIfExists(LEGACY_RELAY_DST);
  removeIfExists(LEGACY_CMD);

  let command;
  if (process.platform === "win32") {
    writeCmdWrapper(runner);
    command = RELAY_CMD;
  } else if (runner.useElectronAsNode) {
    command = `ELECTRON_RUN_AS_NODE=1 "${runner.exe}" "${RELAY_DST}"`;
  } else {
    command = `"${runner.exe}" "${RELAY_DST}"`;
  }

  const config = loadHooksJson();
  stripOurs(config);

  for (const event of EVENTS) {
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    config.hooks[event].push({ command });
  }

  fs.writeFileSync(HOOKS_JSON, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const meta = {
    version,
    runnerExe: runner.exe,
    useElectronAsNode: runner.useElectronAsNode,
    relaySource: relaySrc,
    installedAt: new Date().toISOString(),
  };
  writeInstallMeta(meta);

  return {
    version,
    relay: RELAY_DST,
    command,
    config: HOOKS_JSON,
    meta,
  };
}

function uninstallHooks() {
  const removed = [];

  if (fs.existsSync(HOOKS_JSON)) {
    const config = loadHooksJson();
    stripOurs(config);
    fs.writeFileSync(HOOKS_JSON, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    removed.push(HOOKS_JSON);
  }

  for (const filePath of RELAY_FILES) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removed.push(filePath);
    }
  }

  removeIfExists(INSTALL_META);

  return { removed };
}

function needsHookReinstall(options = {}) {
  const version = resolvePackageVersion(options.version);
  const runner = resolveRunner(options);
  const meta = readInstallMeta();

  if (!hooksSeemInstalled(runner)) return { needed: true, reason: "missing" };
  if (!meta || meta.version !== version) {
    return { needed: true, reason: "version-changed", from: meta?.version, to: version };
  }
  if (meta.runnerExe && meta.runnerExe !== runner.exe) {
    return { needed: true, reason: "runner-changed" };
  }
  return { needed: false, version };
}

function ensureHooks(options = {}) {
  const check = needsHookReinstall(options);
  if (!check.needed) {
    return { installed: false, reason: "up-to-date", version: check.version };
  }
  const result = installHooks(options);
  return { installed: true, reason: check.reason, ...result };
}

module.exports = {
  installHooks,
  uninstallHooks,
  ensureHooks,
  needsHookReinstall,
  readInstallMeta,
  resolveRelaySource,
  resolvePackageVersion,
  INSTALL_META,
  HOOKS_JSON,
  RELAY_DST,
};
