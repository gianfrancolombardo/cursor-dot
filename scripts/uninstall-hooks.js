#!/usr/bin/env node
const { uninstallHooks } = require("./hooks-manager");

try {
  const result = uninstallHooks();
  if (result.removed.length === 0) {
    console.log("No Cursor Dot hooks found to remove.");
  } else {
    for (const filePath of result.removed) {
      console.log(`Updated/removed: ${filePath}`);
    }
  }
  console.log("Cursor Dot hooks uninstalled.");
} catch (err) {
  console.error(`Hook uninstall failed: ${err.message}`);
  process.exit(1);
}
