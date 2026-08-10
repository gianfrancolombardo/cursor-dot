#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const MARKER = "cursor-dot";
const LEGACY_MARKER = "cursor-dash";
const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const HOOKS_DIR = path.join(CURSOR_DIR, "hooks");
const HOOKS_JSON = path.join(CURSOR_DIR, "hooks.json");
const RELAY_FILES = [
  path.join(HOOKS_DIR, "cursor-dot-relay.js"),
  path.join(HOOKS_DIR, "cursor-dot-relay.cmd"),
  path.join(HOOKS_DIR, "cursor-dash-relay.js"),
  path.join(HOOKS_DIR, "cursor-dash-relay.cmd"),
];

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

function main() {
  if (fs.existsSync(HOOKS_JSON)) {
    const config = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
    config.hooks = config.hooks || {};
    for (const [event, list] of Object.entries(config.hooks)) {
      if (!Array.isArray(list)) continue;
      config.hooks[event] = list.filter((entry) => !isOurs(entry));
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }
    fs.writeFileSync(HOOKS_JSON, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    console.log(`Updated ${HOOKS_JSON}`);
  }

  for (const filePath of RELAY_FILES) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Removed ${filePath}`);
    }
  }

  console.log("Cursor Dot hooks uninstalled.");
}

main();
