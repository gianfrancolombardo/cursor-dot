# Cursor Dot

Always-on-top Windows overlay that shows **one glowing dot per Cursor chat**.

| Color | Meaning |
| --- | --- |
| Amber (pulse) | Chat is generating |
| Green | Chat finished |
| Soft halo | Just finished (a few seconds) |

Dots are ordered by last activity (newest first). Up to **8** visible, only for chats updated in the last **5 hours**. New conversation → new dot. Closed or aged-out session → dot disappears.

## Requirements

- Windows
- [Node.js](https://nodejs.org/) 18+
- [Cursor](https://cursor.com/) with hooks enabled

## Install

```bash
git clone https://github.com/gianfrancolombardo/cursor-dot.git
cd cursor-dot
npm install
npm run install-hooks
npm start
```

Restart Cursor once so the hooks load (or check **Customize → Hooks** and confirm the relay is listed).

## Usage

Keep `npm start` running while you work.

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

## Uninstall hooks

```bash
npm run uninstall-hooks
```

## Config

| Variable | Default | Description |
| --- | --- | --- |
| `CURSOR_DOT_PORT` | `17373` | Local HTTP port for the overlay |

## License

MIT
