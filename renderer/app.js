/** @type {Map<string, HTMLButtonElement>} */
const dots = new Map();
/** @type {Map<string, object>} */
const sessionById = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const justFinishedTimers = new Map();

/** Soft cue after amber→green so a freshly finished chat is noticeable. */
const JUST_FINISHED_MS = 6500;
const REORDER_MS = 420;

/** Overlay only shows two chat states: generating vs finished. */
function visualStatus(status) {
  return status === "working" ? "working" : "done";
}

function clearJustFinished(id) {
  const timer = justFinishedTimers.get(id);
  if (timer != null) {
    window.clearTimeout(timer);
    justFinishedTimers.delete(id);
  }
}

function markJustFinished(el, id) {
  clearJustFinished(id);
  el.classList.remove("is-just-finished");
  void el.offsetWidth;
  el.classList.add("is-just-finished");
  const timer = window.setTimeout(() => {
    justFinishedTimers.delete(id);
    el.classList.remove("is-just-finished");
  }, JUST_FINISHED_MS);
  justFinishedTimers.set(id, timer);
}

function statusLabel(status) {
  return visualStatus(status) === "working" ? "generando" : "terminado";
}

/** Compact age from updatedAt, e.g. 10s / 2m / 3h. */
function formatAge(updatedAt, now = Date.now()) {
  const ts = Number(updatedAt) || 0;
  if (!ts) return "";
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function sessionAria(session) {
  const project = session.label || "chat";
  const state = statusLabel(session.status);
  const age = formatAge(session.updatedAt);
  const agePart = age ? ` · ${age}` : "";
  const prompt = session.promptPreview ? ` · ${session.promptPreview}` : "";
  return `${project}${agePart} · ${state}${prompt}`;
}

const tipEl = () => document.getElementById("tip");
const tipProjectEl = () => document.getElementById("tip-project");
const tipAgeEl = () => document.getElementById("tip-age");
const tipPromptEl = () => document.getElementById("tip-prompt");

const TIP_AUTO_HIDE_MS = 2500;
/** @type {ReturnType<typeof setTimeout> | null} */
let tipHideTimer = null;
/** Dot id whose tip was auto-hidden while still hovered/focused. */
let tipSuppressedForId = null;

function clearTipHideTimer() {
  if (tipHideTimer == null) return;
  window.clearTimeout(tipHideTimer);
  tipHideTimer = null;
}

function scheduleTipAutoHide(dotId) {
  clearTipHideTimer();
  tipHideTimer = window.setTimeout(() => {
    tipHideTimer = null;
    tipSuppressedForId = dotId || null;
    hideTip({ keepSuppressed: true });
  }, TIP_AUTO_HIDE_MS);
}

function hideTip({ keepSuppressed = false } = {}) {
  clearTipHideTimer();
  if (!keepSuppressed) tipSuppressedForId = null;
  const tip = tipEl();
  if (!tip) return;
  tip.hidden = true;
  tip.classList.remove("is-visible");
}

function showTipFor(dotEl, session) {
  const tip = tipEl();
  const project = tipProjectEl();
  const age = tipAgeEl();
  const prompt = tipPromptEl();
  if (!tip || !project || !age || !prompt || !dotEl) return;

  const dotId = dotEl.dataset.id || null;
  if (dotId && tipSuppressedForId === dotId) return;

  tipSuppressedForId = null;
  project.textContent = session.label || "chat";
  age.textContent = formatAge(session.updatedAt);
  const preview = session.promptPreview || "";
  prompt.textContent = preview;
  prompt.hidden = !preview;

  tip.hidden = false;
  tip.classList.add("is-visible");

  const stage = document.getElementById("stage");
  const stageBox = stage.getBoundingClientRect();
  const dotBox = dotEl.getBoundingClientRect();

  // Place tip to the left of the pill, vertically centered on the dot.
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const left = Math.max(4, dotBox.left - stageBox.left - tipW - 10);
  let top = dotBox.top - stageBox.top + dotBox.height / 2 - tipH / 2;
  top = Math.max(2, Math.min(top, stageBox.height - tipH - 2));

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  scheduleTipAutoHide(dotId);
}

function bindDotHover(el) {
  if (el.dataset.bound === "1") return;
  el.dataset.bound = "1";

  el.addEventListener("pointerenter", () => {
    tipSuppressedForId = null;
    const session = sessionById.get(el.dataset.id);
    if (session) showTipFor(el, session);
  });
  el.addEventListener("pointerleave", () => hideTip());
  el.addEventListener("focus", () => {
    tipSuppressedForId = null;
    const session = sessionById.get(el.dataset.id);
    if (session) showTipFor(el, session);
  });
  el.addEventListener("blur", () => hideTip());
  el.addEventListener("pointerdown", (ev) => {
    // Prefer pointerdown so the click still carries foreground rights on Windows.
    if (ev.button !== 0) return;
    ev.preventDefault();
    const session = sessionById.get(el.dataset.id);
    const project = session && session.label ? session.label : "";
    window.cursorDot.focusCursor(project).catch(() => {});
  });
}

function ensureDot(session) {
  let el = dots.get(session.conversationId);
  if (el) return el;

  el = document.createElement("button");
  el.type = "button";
  el.className = "dot is-entering";
  el.dataset.id = session.conversationId;
  el.setAttribute("aria-label", sessionAria(session));
  el.addEventListener(
    "animationend",
    (ev) => {
      if (ev.animationName === "dot-in") el.classList.remove("is-entering");
    },
    { once: true }
  );
  window.setTimeout(() => el.classList.remove("is-entering"), 450);
  bindDotHover(el);
  dots.set(session.conversationId, el);
  return el;
}

function captureDotTops(root) {
  /** @type {Map<string, number>} */
  const tops = new Map();
  for (const child of root.children) {
    if (!(child instanceof HTMLElement)) continue;
    const id = child.dataset.id;
    if (!id || child.classList.contains("is-leaving")) continue;
    tops.set(id, child.getBoundingClientRect().top);
  }
  return tops;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateReorder(root, fromTops) {
  if (!fromTops.size || prefersReducedMotion()) return;

  for (const child of root.children) {
    if (!(child instanceof HTMLElement)) continue;
    const id = child.dataset.id;
    if (!id) continue;
    const from = fromTops.get(id);
    if (from == null) continue;

    const to = child.getBoundingClientRect().top;
    const dy = from - to;
    if (Math.abs(dy) < 0.5) continue;

    child.style.transition = "none";
    child.style.translate = `0 ${dy}px`;
    void child.offsetWidth;
    child.style.transition = `translate ${REORDER_MS}ms cubic-bezier(0.2, 0.9, 0.2, 1)`;
    child.style.translate = "0 0";

    const clear = () => {
      child.style.transition = "";
      child.style.translate = "";
      child.removeEventListener("transitionend", onEnd);
    };
    const onEnd = (ev) => {
      if (ev.propertyName !== "translate") return;
      clear();
    };
    child.addEventListener("transitionend", onEnd);
    window.setTimeout(clear, REORDER_MS + 80);
  }
}

function render(state) {
  const theme = state && state.theme === "glass" ? "glass" : "minimal";
  document.documentElement.dataset.theme = theme;

  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const signal = document.getElementById("signal");
  const root = document.getElementById("sessions");
  const alive = new Set(sessions.map((s) => s.conversationId));
  const fromTops = captureDotTops(root);

  sessionById.clear();
  for (const session of sessions) {
    sessionById.set(session.conversationId, session);
  }

  signal.removeAttribute("title");
  signal.dataset.count = String(sessions.length);

  for (const [id, el] of dots) {
    if (alive.has(id)) continue;
    if (el.matches(":hover")) hideTip();
    clearJustFinished(id);
    el.classList.remove("is-just-finished");
    el.classList.add("is-leaving");
    dots.delete(id);
    window.setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  let reordered = false;
  sessions.forEach((session, index) => {
    const el = ensureDot(session);
    const nextStatus = visualStatus(session.status);
    const prevStatus = el.dataset.status;

    el.removeAttribute("title");
    el.setAttribute("aria-label", sessionAria(session));

    if (prevStatus && prevStatus !== nextStatus) {
      if (prevStatus === "working" && nextStatus === "done") {
        markJustFinished(el, session.conversationId);
      } else {
        if (nextStatus === "working") {
          clearJustFinished(session.conversationId);
          el.classList.remove("is-just-finished");
        }
        el.classList.remove("is-status-change");
        void el.offsetWidth;
        el.classList.add("is-status-change");
        window.setTimeout(() => el.classList.remove("is-status-change"), 420);
      }
    }

    el.dataset.status = nextStatus;

    if (el.matches(":hover") || document.activeElement === el) {
      showTipFor(el, session);
    }

    const currentAtIndex = root.children[index];
    if (currentAtIndex !== el) {
      root.insertBefore(el, currentAtIndex || null);
      reordered = true;
    }
  });

  if (reordered) animateReorder(root, fromTops);
}

/**
 * Click-through for transparent chrome; the grip uses native -webkit-app-region
 * drag (avoids DPI setPosition drift). Main blocks ignore-on during will-move.
 */
function setupPointerPolicy(signal) {
  signal.addEventListener("mouseenter", () => {
    window.cursorDot.setMouseIgnore(false);
  });
  signal.addEventListener("mouseleave", () => {
    window.cursorDot.setMouseIgnore(true);
  });
}

async function boot() {
  const signal = document.getElementById("signal");
  // Transparent chrome is click-through; only the pill captures the mouse.
  window.cursorDot.setMouseIgnore(true);
  if (signal) setupPointerPolicy(signal);

  window.cursorDot.onState(render);
  const initial = await window.cursorDot.getState();
  render(initial);

  setInterval(async () => {
    const state = await window.cursorDot.getState();
    render(state);
  }, 5000);
}

boot();
