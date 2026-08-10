#!/usr/bin/env node
/**
 * Cursor hook relay — fail-open, fast exit.
 * 1) Append event to a jsonl file (Electron watches it)
 * 2) Fire-and-forget HTTP POST (no wait for body)
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.CURSOR_DOT_PORT || 17373);
const HOST = "127.0.0.1";
const DATA_DIR = path.join(os.homedir(), ".cursor", "cursor-dot");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const DEBUG_FILE = path.join(DATA_DIR, "relay-debug.jsonl");
const STDIN_MAX_MS = 8000;
const STDIN_IDLE_MS = 300;

function debug(info) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      DEBUG_FILE,
      `${JSON.stringify({ at: Date.now(), ...info })}\n`,
      "utf8"
    );
  } catch {
    // ignore
  }
}

/**
 * Cursor on Windows often prefixes hook stdin with a UTF-8 BOM (or UTF-16).
 * Decode bytes safely and return the JSON object substring.
 */
function decodeHookStdin(buffer) {
  if (!buffer || buffer.length === 0) {
    return { text: "", encoding: "empty" };
  }

  let encoding = "utf8";
  let start = 0;

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    encoding = "utf8-bom";
    start = 3;
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le-bom";
    start = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be-bom";
    start = 2;
  } else if (
    buffer.length >= 4 &&
    buffer[1] === 0x00 &&
    buffer[3] === 0x00 &&
    buffer[0] !== 0x00
  ) {
    // UTF-16 LE without BOM (ASCII-heavy JSON: `{ " ...`)
    encoding = "utf16le";
  }

  let text;
  if (encoding === "utf16le" || encoding === "utf16le-bom") {
    text = buffer.slice(start).toString("utf16le");
  } else if (encoding === "utf16be-bom") {
    const le = Buffer.alloc(buffer.length - start);
    for (let i = start; i + 1 < buffer.length; i += 2) {
      le[i - start] = buffer[i + 1];
      le[i - start + 1] = buffer[i];
    }
    text = le.toString("utf16le");
  } else {
    text = buffer.slice(start).toString("utf8");
  }

  // Node utf8 decoding of a BOM can also leave U+FEFF as the first char.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
    text = text.slice(jsonStart, jsonEnd + 1);
  } else {
    text = text.trim();
  }

  return { text, encoding };
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let idleTimer = null;

    const finish = (reason) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      const buffer = Buffer.concat(chunks);
      const decoded = decodeHookStdin(buffer);
      debug({
        phase: "stdin",
        reason,
        byteLen: buffer.length,
        textLen: decoded.text.length,
        encoding: decoded.encoding,
        isTTY: Boolean(process.stdin.isTTY),
        readable: process.stdin.readable,
        readableEnded: process.stdin.readableEnded,
      });
      resolve(decoded.text);
    };

    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish("idle"), STDIN_IDLE_MS);
    };

    try {
      process.stdin.resume();
    } catch {
      // ignore
    }
    // Binary mode — detect BOM / UTF-16 ourselves (Windows hook runner).
    process.stdin.on("data", (c) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      bumpIdle();
    });
    process.stdin.on("end", () => finish("end"));
    process.stdin.on("close", () => finish("close"));
    process.stdin.on("error", () => finish("error"));
    setTimeout(() => finish("timeout"), STDIN_MAX_MS);

    // If bytes are already buffered, Node may not emit without a tick.
    setImmediate(() => {
      if (!done && chunks.length > 0) bumpIdle();
    });
  });
}

function workspaceLabel(roots) {
  if (!Array.isArray(roots) || roots.length === 0) return "unknown";
  const root = String(roots[0]).replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  const parts = root.split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

/** First words of the user prompt for hover tips (no secrets beyond what hooks already see). */
function promptPreview(prompt, maxChars = 56) {
  if (typeof prompt !== "string") return null;
  const one = prompt.replace(/\s+/g, " ").trim();
  if (!one) return null;
  if (one.length <= maxChars) return one;
  return `${one.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function mapStatus(eventName, payload) {
  if (eventName === "beforeSubmitPrompt") return "working";
  if (eventName === "preToolUse") return "working";
  if (eventName === "afterAgentThought") return "working";
  if (eventName === "stop") {
    if (payload.status === "error") return "error";
    if (payload.status === "aborted") return "idle";
    return "done";
  }
  if (eventName === "sessionEnd") return "gone";
  return "idle";
}

function appendEvent(event) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch (err) {
    debug({ phase: "append", error: String(err && err.message) });
    return false;
  }
}

function postEventFireAndForget(event) {
  try {
    const body = JSON.stringify(event);
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: "/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 200,
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => {});
    req.on("response", (res) => {
      res.resume();
    });
    req.write(body);
    req.end();
  } catch {
    // ignore
  }
}

function ack() {
  try {
    process.stdout.write("{}\n");
  } catch {
    // ignore
  }
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    debug({
      phase: "parse",
      error: String(err && err.message),
      rawPreview: raw.slice(0, 200),
      firstCodes: [...raw.slice(0, 8)].map((ch) => ch.charCodeAt(0)),
    });
    payload = {};
  }

  const eventName = payload.hook_event_name || "unknown";
  const conversationId = payload.conversation_id || payload.session_id || null;

  debug({
    phase: "parsed",
    eventName,
    hasConversationId: Boolean(conversationId),
    keys: Object.keys(payload),
  });

  if (!conversationId) {
    ack();
    process.exit(0);
    return;
  }

  const event = {
    type: "agent",
    event: eventName,
    status: mapStatus(eventName, payload),
    conversationId,
    generationId: payload.generation_id || null,
    workspaceRoots: payload.workspace_roots || [],
    label: workspaceLabel(payload.workspace_roots),
    promptPreview: promptPreview(payload.prompt),
    model: payload.model_id || payload.model || null,
    stopStatus: payload.status || null,
    reason: payload.reason || null,
    at: Date.now(),
  };

  const wrote = appendEvent(event);
  postEventFireAndForget(event);
  debug({ phase: "done", wrote, status: event.status, conversationId });
  ack();

  setTimeout(() => process.exit(0), 50);
}

main().catch((err) => {
  debug({ phase: "fatal", error: String(err && err.message) });
  ack();
  process.exit(0);
});
