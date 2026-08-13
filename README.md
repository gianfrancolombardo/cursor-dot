# Cursor Dot

Always-on-top Windows overlay that shows **one glowing dot per Cursor chat**.

| Color | Meaning |
| --- | --- |
| Amber (pulse) | Chat is generating |
| Green | Chat finished |
| Soft halo | Just finished (a few seconds) |

Dots are ordered by last activity (newest first). Up to **8** visible, only for chats updated in the last **5 hours**. New conversation → new dot. Closed or aged-out session → dot disappears.

## Requirements

- Windows 10/11 (x64)
- [Cursor](https://cursor.com/) with hooks enabled
- For **development** only: [Node.js](https://nodejs.org/) 18+

The packaged installer does **not** require Node.js. Hooks run with Electron-as-Node.

## Install (Windows installer)

1. Build the installer (from a machine with Node.js):

```bat
npm install
npm run dist
```

2. Run the generated setup from `dist\`:

`Cursor Dot-Setup-<version>-x64.exe`

3. Finish the wizard (choose install folder if you want).
4. Restart Cursor once so hooks reload (or check **Customize → Hooks**).
5. Launch **Cursor Dot** from the Start Menu / Desktop shortcut.

The installer also registers Cursor hooks automatically. On every app launch, hooks are re-synced if the app version or install path changed.

### Portable build (optional)

```bat
npm run dist:portable
```

Run `Cursor Dot-Portable-<version>-x64.exe`. First launch installs/syncs hooks.

## Upgrade / reinstall after changes

Bump `version` in `package.json` (for example `1.0.0` → `1.0.1`), then:

```bat
npm run win:reinstall
```

Or manually:

```bat
npm install
npm run dist
```

Install the new setup over the previous one. Windows Add/Remove Programs keeps a single entry; NSIS replaces the previous version. Hooks are rewritten to the new exe path/version.

Quick hook-only refresh while developing:

```bat
npm run reinstall-hooks
npm start
```

## Uninstall

**Recommended:** Windows **Settings → Apps → Installed apps → Cursor Dot → Uninstall**.

That removes:

- The app from Program Files / local install dir
- Start Menu / Desktop shortcuts
- Cursor hooks registered by Cursor Dot

App settings under `%APPDATA%\Cursor Dot` are kept by default so a reinstall restores theme/session prefs. Delete that folder manually if you want a clean slate.

**Hooks only** (keep the app):

```bat
npm run uninstall-hooks
```

Or, if installed:

```bat
"%LOCALAPPDATA%\Programs\Cursor Dot\Cursor Dot.exe" --uninstall-hooks
```

## Development install

```bash
git clone https://github.com/gianfrancolombardo/cursor-dot.git
cd cursor-dot
npm install
npm run install-hooks
npm start
```

Restart Cursor once so the hooks load (or check **Customize → Hooks** and confirm the relay is listed).

## Usage

Keep the overlay running while you work (`npm start` or the installed app).

- Each circle = one chat conversation (not a UI tab index)
- Hover a dot → tooltip with project, age, and prompt preview
- Click a dot → focus that chat’s Cursor window (or **Cursor Agents** for Agent Window sessions)
- Drag the grip at the top of the pill to move the overlay
- Tray icon → show/hide, clear finished, theme (**Minimalista** / **Glass**), quit

## How it works

```
Cursor hooks  ──POST──►  Electron (127.0.0.1:17373)  ──►  overlay
                 │
                 └── also appends to ~/.cursor/cursor-dot/events.jsonl
```

1. Hooks fire on `beforeSubmitPrompt`, `stop`, and `sessionEnd`
2. A small relay posts the event to localhost (fail-open: if the overlay is down, agents are never blocked)
3. The Electron app updates the dots instantly

## Config

| Variable | Default | Description |
| --- | --- | --- |
| `CURSOR_DOT_PORT` | `17373` | Local HTTP port for the overlay |

## Versioning

| File / command | Role |
| --- | --- |
| `package.json` → `version` | Source of truth for installer + hook metadata |
| `~/.cursor/cursor-dot/install-meta.json` | Records installed hook version and runner path |
| `npm run dist` | Builds `Cursor Dot-Setup-<version>-x64.exe` |
| App launch / installer | Reinstalls hooks when version or path changes |

## License

MIT
