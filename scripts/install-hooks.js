#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const MARKER = "cursor-dot";
const LEGACY_MARKER = "cursor-dash";
const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const HOOKS_DIR = path.join(CURSOR_DIR, "hooks");
const HOOKS_JSON = path.join(CURSOR_DIR, "hooks.json");
const RELAY_SRC = path.join(__dirname, "..", "hooks", "relay.js");
const RELAY_DST = path.join(HOOKS_DIR, "cursor-dot-relay.js");
const LEGACY_RELAY_DST = path.join(HOOKS_DIR, "cursor-dash-relay.js");
const LEGACY_CMD = path.join(HOOKS_DIR, "cursor-dash-relay.cmd");

// Keep this lean: preToolUse/afterAgentThought fire too often and spawn Node each time.
const EVENTS = ["beforeSubmitPrompt", "stop", "sessionEnd"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function main() {
  ensureDir(HOOKS_DIR);
  fs.copyFileSync(RELAY_SRC, RELAY_DST);
  removeIfExists(LEGACY_RELAY_DST);
  removeIfExists(LEGACY_CMD);

  const nodeExe =
    process.execPath && path.basename(process.execPath).toLowerCase().includes("node")
      ? process.execPath
      : "node";

  // On Windows, a .cmd wrapper avoids nested-quote stdin issues with Cursor's hook runner.
  let command;
  if (process.platform === "win32") {
    const cmdPath = path.join(HOOKS_DIR, "cursor-dot-relay.cmd");
    const cmdBody = `@echo off\r\n"${nodeExe}" "%~dp0cursor-dot-relay.js"\r\n`;
    fs.writeFileSync(cmdPath, cmdBody, "utf8");
    command = cmdPath;
  } else {
    command = `"${nodeExe}" "${RELAY_DST}"`;
  }

  const config = loadHooksJson();
  stripOurs(config);

  for (const event of EVENTS) {
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    config.hooks[event].push({
      command,
    });
  }

  fs.writeFileSync(HOOKS_JSON, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  console.log("Installed Cursor Dot hooks:");
  console.log(`  relay: ${RELAY_DST}`);
  console.log(`  config: ${HOOKS_JSON}`);
  console.log("Restart Cursor (or wait for hooks reload), then run: npm start");
}

main();
