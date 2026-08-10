# Cursor Dot

Always-on-top overlay for Windows: **one dot per chat conversation**.

- Amber pulse = that chat is **working**
- Green = that chat is **done** (brief soft halo when it just finished)
- Dots sorted by last update (newest first), max **8**, only if updated in the last **5h**
- New conversation → new dot; closed / aged-out session → dot removed

## How it works

1. Cursor **hooks** fire on prompt submit / stop / session end.
2. A tiny relay POSTs the event to `http://127.0.0.1:17373` (milliseconds, no polling).
3. The Electron overlay updates instantly.

```
Cursor hooks  --POST-->  Electron (localhost)  -->  glass overlay
```

## Setup

```bash
npm install
npm run install-hooks
npm start
```

Then restart Cursor once (or check **Customize → Hooks** that the relay is listed).

## Usage

- Keep `npm start` running while you work.
- Each circle is one chat session.
- Click a circle to focus that chat's Cursor project window (or **Cursor Agents** if it's an Agent Window session).
- Tray icon: show/hide, clear finished, appearance (**Minimalista** / **Glass**), quit.
- Drag the pill (grip at the top) to move the window.

## Uninstall hooks

```bash
npm run uninstall-hooks
```

## Notes

- Status is per **conversation**, not per visual chat tab index.
- If the overlay is closed, hooks fail open (agents are never blocked).
- Port override: `CURSOR_DOT_PORT=17373`
