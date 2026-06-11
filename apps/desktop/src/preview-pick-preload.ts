// @effect-diagnostics globalDate:off
/**
 * Preview pick preload — runs in the isolated world of the Chromium
 * `<webview>` that hosts the in-app browser. Loaded via the
 * `<webview preload="...">` attribute set by the renderer.
 *
 * Responsibilities:
 *
 * 1. Listen for `preview:start-pick` from main (sent through
 *    `WebContents.send`, received here via `ipcRenderer.on`).
 * 2. Mount a minimal blue-highlight element picker on the page.
 * 3. On click → call `react-grab/primitives.getElementContext` and bubble
 *    a `PickedElementPayload` to main via `ipcRenderer.send`. Main resolves
 *    the in-flight `pickElement(tabId)` promise via its per-WebContents
 *    `wc.ipc.on(...)` listener.
 * 4. Tear down the picker on Escape, blur, navigation, or explicit cancel.
 *
 * Design notes:
 *
 * - We never modify the page's DOM tree — the highlight + crosshair cursor
 *   live on a single fixed-position overlay layer that we own. This keeps
 *   us safe against pages that reset DOM or do MutationObserver tracking.
 * - The overlay uses `pointer-events: none` so clicks fall through to the
 *   real element behind it; we do hit-testing with `elementFromPoint`.
 * - Only a single pick session is ever active per webview; re-activating
 *   silently replaces the previous session.
 * - Cancellations triggered BY MAIN (CANCEL_PICK_CHANNEL, or a follow-up
 *   START_PICK_CHANNEL that supersedes the current session) tear down
 *   silently — they do NOT echo a `null` ELEMENT_PICKED back, because main
 *   already knows it cancelled and would otherwise resolve the freshly-
 *   registered next-pick listener with that stale `null`. Cancellations
 *   triggered by the USER (Escape, beforeunload, click on empty) DO send
 *   `null` back so main can resolve the in-flight pick promise.
 */
import { ipcRenderer } from "electron";
import { getElementContext } from "react-grab/primitives";
import type { PickedElementPayload, PickedElementStackFrame } from "@t3tools/contracts";

import { computeLabelPosition } from "./preview-pick-label-position.ts";

const START_PICK_CHANNEL = "preview:start-pick";
const CANCEL_PICK_CHANNEL = "preview:cancel-pick";
const ELEMENT_PICKED_CHANNEL = "preview:element-picked";

const HIGHLIGHT_COLOR = "rgba(37, 99, 235, 0.9)"; // blue-600
const HIGHLIGHT_FILL = "rgba(37, 99, 235, 0.16)";
const LABEL_BG = "rgba(37, 99, 235, 0.96)";
const Z_INDEX_OVERLAY = 2147483646;

interface PickSession {
  readonly overlay: HTMLDivElement;
  readonly outline: HTMLDivElement;
  readonly label: HTMLDivElement;
  /**
   * Tear down listeners + DOM WITHOUT notifying main. Used when main itself
   * initiated the cancel (CANCEL_PICK_CHANNEL) or when a follow-up startPick
   * supersedes us — main is already waiting on a fresh listener and would
   * otherwise resolve it with the stale `null` we'd send.
   */
  readonly teardownSilent: () => void;
}

let activeSession: PickSession | null = null;

function endActiveSession(): void {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  // Supersession from a new startPick is a main-initiated transition: tear
  // down silently so the new pick's main-side listener doesn't receive a
  // ghost `null` from the old session.
  session.teardownSilent();
}

interface OverlayHandles {
  readonly overlay: HTMLDivElement;
  readonly outline: HTMLDivElement;
  readonly label: HTMLDivElement;
  readonly destroyDom: () => void;
}

function createOverlay(): OverlayHandles {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-t3code-pick-overlay", "");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:" + String(Z_INDEX_OVERLAY),
    "pointer-events:none",
    "cursor:crosshair",
    // Some apps register `pointer-events: auto !important` on body — using a
    // dedicated overlay element ensures we don't fight with that.
  ].join(";");

  const outline = document.createElement("div");
  outline.setAttribute("data-t3code-pick-outline", "");
  outline.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "width:0",
    "height:0",
    "border:2px solid " + HIGHLIGHT_COLOR,
    "background:" + HIGHLIGHT_FILL,
    "border-radius:2px",
    "box-shadow:0 0 0 1px rgba(255,255,255,0.6) inset",
    "transition:none",
    "display:none",
    "pointer-events:none",
  ].join(";");

  const label = document.createElement("div");
  label.setAttribute("data-t3code-pick-label", "");
  // `top:0; left:0` so transform translate() positions are absolute viewport
  // coordinates (we re-anchor the label every paint via a single transform).
  // `max-width: calc(100vw - 8px)` + ellipsis prevents an overly long
  // tag#id.class string from overflowing the viewport horizontally before we
  // even get to the clamp logic.
  label.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "padding:2px 6px",
    "background:" + LABEL_BG,
    "color:white",
    "font:600 11px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif",
    "border-radius:3px",
    "pointer-events:none",
    "white-space:nowrap",
    "max-width:calc(100vw - 8px)",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "box-shadow:0 1px 2px rgba(0,0,0,0.25)",
    "display:none",
  ].join(";");

  overlay.appendChild(outline);
  overlay.appendChild(label);
  document.documentElement.appendChild(overlay);

  // Force the crosshair cursor across the whole page even though we set it
  // on the overlay (because pointer-events: none means it's never the
  // cursor target). We add a stylesheet rule and revert on cleanup.
  const styleEl = document.createElement("style");
  styleEl.textContent = `html[data-t3code-picking="1"], html[data-t3code-picking="1"] *, html[data-t3code-picking="1"] *::before, html[data-t3code-picking="1"] *::after { cursor: crosshair !important; }`;
  document.documentElement.appendChild(styleEl);
  document.documentElement.setAttribute("data-t3code-picking", "1");

  const destroyDom = (): void => {
    overlay.remove();
    styleEl.remove();
    document.documentElement.removeAttribute("data-t3code-picking");
  };

  return { overlay, outline, label, destroyDom };
}

/**
 * Resolve the element under the cursor while ignoring our own overlay.
 * We render at z-index 2147483646 with `pointer-events: none`, which means
 * `elementFromPoint` already skips the overlay — but we double-guard against
 * pages that mutate `pointer-events` via MutationObservers.
 */
function pickFromPoint(clientX: number, clientY: number): Element | null {
  const candidates = document.elementsFromPoint(clientX, clientY);
  for (const candidate of candidates) {
    if (!(candidate instanceof Element)) continue;
    if (candidate.hasAttribute("data-t3code-pick-overlay")) continue;
    if (candidate.hasAttribute("data-t3code-pick-outline")) continue;
    if (candidate.hasAttribute("data-t3code-pick-label")) continue;
    if (candidate === document.documentElement) continue;
    if (candidate === document.body) continue;
    return candidate;
  }
  return null;
}

function describeRawElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const className =
    element instanceof HTMLElement && typeof element.className === "string"
      ? element.className
          .trim()
          .split(/\s+/)
          .filter((token) => token.length > 0)
          .slice(0, 2)
          .map((token) => `.${token}`)
          .join("")
      : "";
  return `${tag}${id}${className}`;
}

/**
 * Per-session cache of the resolved React component name for elements we've
 * already inspected. Stores `null` when react-grab couldn't find a component
 * (raw HTML / unmounted) so repeat hovers don't re-pay the async lookup.
 */
const componentNameCache = new WeakMap<Element, string | null>();
const componentNameInFlight = new WeakSet<Element>();

function describeElement(element: Element): string {
  const cached = componentNameCache.get(element);
  if (cached) return `<${cached}>  ${describeRawElement(element)}`;
  return describeRawElement(element);
}

function paintOutline(handles: OverlayHandles, element: Element): void {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    handles.outline.style.display = "none";
    handles.label.style.display = "none";
    return;
  }
  handles.outline.style.display = "block";
  handles.outline.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  handles.outline.style.width = `${rect.width}px`;
  handles.outline.style.height = `${rect.height}px`;

  // Two-pass label paint: first apply the new text and force-block display
  // so we can measure the rendered size, then clamp to the viewport and
  // flip below the element when there isn't room above.
  const text = describeElement(element);
  if (handles.label.textContent !== text) {
    handles.label.textContent = text;
  }
  handles.label.style.display = "block";

  const labelRect = handles.label.getBoundingClientRect();
  const { x, y } = computeLabelPosition({
    targetLeft: rect.left,
    targetTop: rect.top,
    targetBottom: rect.bottom,
    labelWidth: labelRect.width,
    labelHeight: labelRect.height,
    viewportWidth: document.documentElement.clientWidth || window.innerWidth || labelRect.width,
    viewportHeight: document.documentElement.clientHeight || window.innerHeight || labelRect.height,
  });
  handles.label.style.transform = `translate(${x}px, ${y}px)`;
}

/**
 * Kick off (at most once per element) an async react-grab lookup for the
 * component name. When the answer arrives, repaint the label iff the element
 * is still under the cursor — otherwise the user has moved on and a stale
 * paint would clobber the next element's label.
 */
function ensureComponentName(element: Element, onResolve: (resolvedFor: Element) => void): void {
  if (componentNameCache.has(element)) return;
  if (componentNameInFlight.has(element)) return;
  componentNameInFlight.add(element);
  void getElementContext(element)
    .then((context) => {
      const trimmed = context.componentName?.trim();
      componentNameCache.set(element, trimmed && trimmed.length > 0 ? trimmed : null);
    })
    .catch(() => {
      componentNameCache.set(element, null);
    })
    .finally(() => {
      componentNameInFlight.delete(element);
      onResolve(element);
    });
}

function clearOutline(handles: OverlayHandles): void {
  handles.outline.style.display = "none";
  handles.label.style.display = "none";
}

function toStackFrame(frame: {
  functionName?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}): PickedElementStackFrame {
  return {
    functionName: frame.functionName ?? null,
    fileName: frame.fileName ?? null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  };
}

async function captureElement(element: Element): Promise<PickedElementPayload | null> {
  try {
    const context = await getElementContext(element);
    const stack = (context.stack ?? []).map((frame) => toStackFrame(frame));
    return {
      pageUrl: location.href,
      pageTitle: document.title?.trim() ? document.title.trim() : null,
      tagName: element.tagName.toLowerCase(),
      selector: context.selector,
      htmlPreview: context.htmlPreview ?? "",
      componentName: context.componentName,
      source: stack[0] ?? null,
      stack,
      styles: context.styles ?? "",
      pickedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function startPick(): void {
  endActiveSession();
  if (typeof document === "undefined" || !document.body) {
    ipcRenderer.send(ELEMENT_PICKED_CHANNEL, null);
    return;
  }

  const handles = createOverlay();
  let lastTarget: Element | null = null;
  let resolved = false;

  // Tear down listeners + DOM. Does NOT notify main. `notifyMain` controls
  // whether we additionally bubble a `null` ELEMENT_PICKED back so main can
  // resolve the in-flight pick promise (only true for USER-initiated cancels;
  // main already knows about its own cancellations).
  const teardown = (notifyMain: boolean, payload: PickedElementPayload | null): void => {
    if (resolved) return;
    resolved = true;
    window.removeEventListener("mousemove", onMove, { capture: true } as EventListenerOptions);
    window.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
    window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
    window.removeEventListener("scroll", onScrollOrResize, {
      capture: true,
    } as EventListenerOptions);
    window.removeEventListener("resize", onScrollOrResize);
    window.removeEventListener("beforeunload", onBeforeUnload);
    ipcRenderer.off(CANCEL_PICK_CHANNEL, onMainCancel);
    handles.destroyDom();
    if (notifyMain) {
      // `ipcRenderer.send` (NOT `sendToHost`) reaches main, where the
      // PreviewViewManager's per-WebContents `wc.ipc.on(...)` listener
      // resolves the in-flight pick promise.
      ipcRenderer.send(ELEMENT_PICKED_CHANNEL, payload);
    }
  };

  // Re-paint when an in-flight component-name lookup resolves, but only if
  // the same element is still under the cursor — otherwise the user moved on
  // and we'd clobber the next element's label.
  const onComponentNameResolved = (resolvedFor: Element): void => {
    if (lastTarget !== resolvedFor) return;
    paintOutline(handles, resolvedFor);
  };

  const onMove = (event: MouseEvent): void => {
    const target = pickFromPoint(event.clientX, event.clientY);
    if (target === lastTarget) return;
    lastTarget = target;
    if (target) {
      paintOutline(handles, target);
      ensureComponentName(target, onComponentNameResolved);
    } else {
      clearOutline(handles);
    }
  };

  const onScrollOrResize = (): void => {
    if (lastTarget) paintOutline(handles, lastTarget);
  };

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const target = pickFromPoint(event.clientX, event.clientY);
    if (!target) {
      teardown(true, null);
      return;
    }
    void captureElement(target).then((payload) => teardown(true, payload));
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      teardown(true, null);
    }
  };

  const onBeforeUnload = (): void => {
    teardown(true, null);
  };

  // Cancellation initiated by main (CANCEL_PICK_CHANNEL). Tear down silently
  // — main already knows it cancelled and is either done waiting or about to
  // register a fresh listener for a new pick. If we sent `null` here, that
  // fresh listener would receive it and resolve the new pick instantly (the
  // C1 race we previously hit).
  const onMainCancel = (): void => {
    teardown(false, null);
  };

  // Capture-phase listeners on `window` to outrun page handlers that
  // `stopPropagation()` early. `passive: false` because we need preventDefault.
  window.addEventListener("mousemove", onMove, { capture: true, passive: true });
  window.addEventListener("click", onClick, { capture: true });
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
  window.addEventListener("resize", onScrollOrResize, { passive: true });
  window.addEventListener("beforeunload", onBeforeUnload);
  ipcRenderer.on(CANCEL_PICK_CHANNEL, onMainCancel);

  // Hand a "silent teardown" to `activeSession` so that a follow-up
  // `startPick()` can supersede us without echoing `null` back to main.
  activeSession = {
    overlay: handles.overlay,
    outline: handles.outline,
    label: handles.label,
    teardownSilent: () => teardown(false, null),
  };
}

ipcRenderer.on(START_PICK_CHANNEL, () => {
  startPick();
});
