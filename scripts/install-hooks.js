#!/usr/bin/env node
const { installHooks } = require("./hooks-manager");

try {
  const result = installHooks();
  console.log("Installed Cursor Dot hooks:");
  console.log(`  version: ${result.version}`);
  console.log(`  relay:   ${result.relay}`);
  console.log(`  command: ${result.command}`);
  console.log(`  config:  ${result.config}`);
  console.log("");
  console.log("Restart Cursor (or wait for hooks reload), then start the overlay.");
} catch (err) {
  console.error(`Hook install failed: ${err.message}`);
  process.exit(1);
}
