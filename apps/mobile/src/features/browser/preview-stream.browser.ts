import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamInput,
  type PreviewStreamPointer,
  type PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";

import type { PreviewStreamConfiguration, PreviewStreamMessage } from "./preview-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

/** WebKit's presentation API, the only picture in picture entry on older iOS. */
interface PresentationVideo extends HTMLVideoElement {
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitPresentationMode?: string;
}

type WheelInput = Extract<PreviewStreamInput, { type: "wheel" }>;
type MouseInput = Extract<PreviewStreamInput, { type: "mouse" }>;
const mouseButton = (button: number): MouseInput["button"] =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

const RESIZE_DEBOUNCE_MS = 150;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const WHEEL_LINE_PX = 16;
// JPEG frames past 2x cost bandwidth without a visible gain on a phone.
const MAX_PIXEL_RATIO = 2;
// A tap this close to an answered probe, this soon, reuses its answer. On a slow
// link the answer lands after touch end, too late for iOS to raise the keyboard.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// Kept in the hidden textarea so a soft keyboard's backspace has something to
// delete and fires `input`; Gboard's keydown carries keyCode 229 and no key.
const SENTINEL = "\u200b";
// The agent cursor stays bright while the agent acts, then dims like the web panel's.
const AGENT_CURSOR_ACTIVE_MS = 700;
const AGENT_CURSOR_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>';

interface Viewer {
  readonly stop: () => void;
  readonly command: (input: PreviewStreamInput) => void;
  readonly togglePictureInPicture: () => void;
}

let activeViewer: Viewer | null = null;

export function stop() {
  activeViewer?.stop();
  activeViewer = null;
}

/** Navigation and history from the native chrome require current browser control. */
export function command(input: PreviewStreamInput) {
  activeViewer?.command(input);
}

export function pictureInPicture() {
  activeViewer?.togglePictureInPicture();
}

export function start(configuration: PreviewStreamConfiguration) {
  stop();
  const post = (message: PreviewStreamMessage) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const { interactive } = configuration;
  document.body.style.background = configuration.background;
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Browser page");
  const agentCursor = document.createElement("div");
  agentCursor.className = "agent-cursor";
  agentCursor.setAttribute("aria-hidden", "true");
  agentCursor.innerHTML = AGENT_CURSOR_SVG;
  container.append(canvas, agentCursor);
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Browser page input");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.disabled = true;
  document.body.replaceChildren(container, ...(interactive ? [input] : []));

  let stopped = false;
  let streaming = false;
  let viewport: PreviewStreamViewport | null = null;
  let size: { width: number; height: number } | null = null;
  // Frame cap in device px, fixed per socket. It only grows, so only outgrowing it reconnects.
  let cap: { width: number; height: number } | null = null;
  let client: PreviewStreamClient | null = null;
  let control: PreviewStreamControl | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelFrame: number | null = null;
  let pendingWheel: WheelInput | null = null;
  let mouseFrame: number | null = null;
  let pendingMouse: MouseInput | null = null;
  let mouseButtons = 0;
  const mouseClicks = { left: 1, middle: 1, right: 1, none: 1 };
  // The latest probe. `editable` is the answer its tap acts on, null until known;
  // `end` records what touch end did, so a late answer can still act or correct it.
  let probe: {
    readonly x: number;
    readonly y: number;
    readonly clientX: number;
    readonly clientY: number;
    editable: boolean | null;
    end: "touching" | "acted" | "late" | "panned";
  } | null = null;
  let probeCache: {
    readonly clientX: number;
    readonly clientY: number;
    readonly editable: boolean;
    readonly time: number;
  } | null = null;
  // A keydown already sent this key; its `input` must not send it again.
  let keySent = false;
  let touch: {
    start: PointerEvent;
    last: PointerEvent;
    panning: boolean;
  } | null = null;
  let lastTap: {
    time: number;
    x: number;
    y: number;
    count: number;
    button: MouseInput["button"];
  } | null = null;

  const reportStatus = (status: "connecting" | "streaming") => {
    streaming = status === "streaming";
    post({ type: "status", status });
  };
  const painter = createPreviewFramePainter(canvas, () => {
    if (!streaming && !stopped) reportStatus("streaming");
    sendPictureInPictureFrame();
  });
  const send = (message: PreviewStreamInput) => client?.send(message) ?? false;
  const clearInput = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
    if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
    wheelFrame = mouseFrame = null;
    pendingWheel = pendingMouse = null;
    mouseButtons = 0;
    Object.assign(mouseClicks, { left: 1, middle: 1, right: 1, none: 1 });
    probe = probeCache = touch = lastTap = null;
    keySent = false;
    input.value = SENTINEL;
    input.disabled = true;
    input.blur();
  };

  const connect = () => {
    // Stopping suppresses the old socket's disconnect report; native also drops its control.
    if (client) reportStatus("connecting");
    client?.stop();
    control = null;
    clearInput();
    if (!cap || stopped) return;
    const next = createPreviewStreamClient(
      {
        access: configuration.access,
        threadId: configuration.threadId,
        tabId: configuration.tabId,
        maxWidth: cap.width,
        maxHeight: cap.height,
        interactive,
      },
      {
        onFrame: (jpeg) => painter.paint(jpeg),
        onPointer: showAgentCursor,
        onClipboard: (text) => post({ type: "clipboard", text }),
        onDownload: (download) => post({ type: "download", ...download }),
        onFileChooser: (chooser) => post({ type: "fileChooser", chooser }),
        onViewport: (page) => {
          if (viewport?.width === page.width && viewport.height === page.height) return;
          viewport = page;
          post({ type: "viewport", width: page.width, height: page.height });
        },
        onProbe: (result) => {
          if (control?.controller !== "you") return;
          const current = probe;
          if (!current || current.x !== result.x || current.y !== result.y) return;
          probeCache = {
            clientX: current.clientX,
            clientY: current.clientY,
            editable: result.editable,
            time: performance.now(),
          };
          if (current.end === "touching") {
            current.editable = result.editable;
            return;
          }
          probe = null;
          if (current.end === "panned") return;
          if (current.end === "acted" && current.editable === result.editable) return;
          // Late or corrected answer: Android still raises the keyboard; iOS waits
          // for the next tap, which can reuse this answer.
          if (result.editable) input.focus({ preventScroll: true });
          else input.blur();
        },
        onControl: (nextControl) => {
          const previous = control;
          control = nextControl;
          post({ type: "control", ...nextControl });
          // Taking over hides the agent cursor; the person's own touch is the pointer now.
          if (nextControl.controller === "you") agentCursor.style.opacity = "0";
          if (nextControl.controller !== "you") clearInput();
          else {
            input.disabled = !interactive;
            if (interactive && size && previous?.controller !== "you")
              next.send({ type: "resize", ...size });
          }
        },
        onConnectedChange: (connected) => {
          if (!connected) {
            control = null;
            clearInput();
            if (streaming) reportStatus("connecting");
            return;
          }
        },
        onUnauthorized: () => post({ type: "unauthorized" }),
        onGone: () => post({ type: "gone" }),
        onHostSetup: (setup) => post({ type: "hostSetup", ...setup }),
      },
    );
    client = next;
  };

  const measure = () => {
    resizeTimer = null;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    if (size?.width === next.width && size.height === next.height) return;
    size = next;
    if (interactive) send({ type: "resize", ...next });
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    // The floating player scales a page of any shape into its box, so its cap is square.
    const side = Math.max(next.width, next.height);
    const width = Math.round((interactive ? next.width : side) * ratio);
    const height = Math.round((interactive ? next.height : side) * ratio);
    if (cap && cap.width >= width && cap.height >= height) return;
    cap = { width: Math.max(width, cap?.width ?? 0), height: Math.max(height, cap?.height ?? 0) };
    connect();
  };
  const observer = new ResizeObserver(() => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    // The first size connects right away; later ones settle before resizing the page.
    resizeTimer = setTimeout(measure, size === null ? 0 : RESIZE_DEBOUNCE_MS);
  });
  observer.observe(container);

  // iOS keeps the layout viewport under the soft keyboard; follow the visible area
  // so the page resizes above it.
  const visualViewport = window.visualViewport;
  const followVisualViewport = () => {
    if (!visualViewport) return;
    container.style.top = `${visualViewport.offsetTop}px`;
    container.style.height = `${visualViewport.height}px`;
  };
  if (interactive) {
    visualViewport?.addEventListener("resize", followVisualViewport);
    visualViewport?.addEventListener("scroll", followVisualViewport);
  }

  let agentCursorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mirrors the frame's letterbox so the cursor lands on the element the agent targets. */
  const showAgentCursor = (pointer: PreviewStreamPointer) => {
    if (!viewport || canvas.width === 0 || canvas.height === 0 || control?.controller === "you")
      return;
    const box = { width: canvas.clientWidth, height: canvas.clientHeight };
    const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    const left = (box.width - width) / 2 + (pointer.x * width) / viewport.width;
    const top = (box.height - height) / 2 + (pointer.y * height) / viewport.height;
    agentCursor.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    agentCursor.style.opacity = "1";
    if (pointer.phase === "click") {
      agentCursor.querySelector(".ping")?.remove();
      const ping = document.createElement("span");
      ping.className = "ping";
      agentCursor.prepend(ping);
    }
    if (agentCursorTimer !== null) clearTimeout(agentCursorTimer);
    agentCursorTimer = setTimeout(() => {
      agentCursor.style.opacity = control?.controller === "agent" ? "0.35" : "0";
    }, AGENT_CURSOR_ACTIVE_MS);
  };

  const pagePoint = (clientX: number, clientY: number, clamp: boolean) => {
    if (!viewport || canvas.width === 0 || canvas.height === 0 || control?.controller !== "you")
      return null;
    const rect = canvas.getBoundingClientRect();
    // `object-fit: contain` letterboxes the frame inside the canvas box.
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    if (!(width > 0 && height > 0)) return null;
    const scale = viewport.width / width;
    const x = (clientX - rect.left - (rect.width - width) / 2) * scale;
    const y = (clientY - rect.top - (rect.height - height) / 2) * (viewport.height / height);
    const inside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
    if (!inside && !clamp) return null;
    return {
      x: Math.min(Math.max(x, 0), viewport.width),
      y: Math.min(Math.max(y, 0), viewport.height),
      scale,
    };
  };

  // Wheel deltas coalesce to one message per animation frame.
  const flushWheel = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
    wheelFrame = null;
    const wheel = pendingWheel;
    pendingWheel = null;
    if (wheel) send(wheel);
  };
  const queueWheel = (point: { x: number; y: number }, deltaX: number, deltaY: number) => {
    pendingWheel = {
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: (pendingWheel?.deltaX ?? 0) + deltaX,
      deltaY: (pendingWheel?.deltaY ?? 0) + deltaY,
      modifiers: 0,
    };
    wheelFrame ??= requestAnimationFrame(flushWheel);
  };

  const flushMouse = () => {
    if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
    mouseFrame = null;
    if (pendingMouse) send(pendingMouse);
    pendingMouse = null;
  };
  const countClick = (event: PointerEvent, button: MouseInput["button"]) => {
    const last = lastTap;
    const count =
      last &&
      last.button === button &&
      event.timeStamp - last.time < MULTI_CLICK_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < MULTI_CLICK_SLOP_PX
        ? last.count + 1
        : 1;
    lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY, count, button };
    return count;
  };
  const mouseInput = (
    event: PointerEvent,
    point: { x: number; y: number },
    action: MouseInput["action"],
    button: MouseInput["button"],
    buttons = event.buttons,
    clickCount = mouseClicks[button],
  ): MouseInput => ({
    type: "mouse",
    action,
    x: point.x,
    y: point.y,
    button,
    buttons,
    clickCount,
    modifiers: previewStreamModifiers(event),
  });
  const onPointerDown = (event: PointerEvent) => {
    if (control?.controller !== "you") return;
    if (!event.isPrimary) return;
    event.preventDefault();
    if (event.pointerType !== "touch") {
      const point = pagePoint(event.clientX, event.clientY, false);
      if (!point) return;
      canvas.setPointerCapture(event.pointerId);
      input.focus({ preventScroll: true });
      flushMouse();
      flushWheel();
      mouseButtons = event.buttons & 7;
      const button = mouseButton(event.button);
      mouseClicks[button] = countClick(event, button);
      send(mouseInput(event, point, "down", button));
      return;
    }
    touch = { start: event, last: event, panning: false };
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) {
      probe = null;
      return;
    }
    const cached = probeCache;
    const reuse =
      cached !== null &&
      performance.now() - cached.time < PROBE_REUSE_MS &&
      Math.hypot(event.clientX - cached.clientX, event.clientY - cached.clientY) <= PROBE_REUSE_PX;
    probe = {
      x: point.x,
      y: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
      editable: reuse ? cached.editable : null,
      end: "touching",
    };
    // Sent even with a cached answer, so the next tap reuses a fresh one.
    send({ type: "probe", x: point.x, y: point.y });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (control?.controller !== "you") return;
    if (event.pointerType !== "touch") {
      const point = pagePoint(event.clientX, event.clientY, mouseButtons !== 0);
      if (!point) return;
      // Chorded presses and releases arrive as pointermove while another button is held.
      const changed = mouseButtons ^ (event.buttons & 7);
      if (mouseButtons !== 0 && changed !== 0) {
        flushMouse();
        flushWheel();
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          const button = bit === 1 ? "left" : bit === 2 ? "right" : "middle";
          const down = (event.buttons & bit) !== 0;
          mouseButtons ^= bit;
          if (down) mouseClicks[button] = countClick(event, button);
          send(mouseInput(event, point, down ? "down" : "up", button, mouseButtons));
        }
      }
      const button =
        mouseButtons & 1
          ? "left"
          : mouseButtons & 2
            ? "right"
            : mouseButtons & 4
              ? "middle"
              : "none";
      pendingMouse = mouseInput(event, point, "move", button, event.buttons, 0);
      mouseFrame ??= requestAnimationFrame(flushMouse);
      return;
    }
    if (!touch || touch.start.pointerId !== event.pointerId) return;
    if (
      !touch.panning &&
      Math.hypot(event.clientX - touch.start.clientX, event.clientY - touch.start.clientY) <
        TAP_SLOP_PX
    ) {
      return;
    }
    touch.panning = true;
    const point = pagePoint(event.clientX, event.clientY, true);
    // Dragging the page up scrolls it down, following the finger.
    if (point) {
      queueWheel(
        point,
        (touch.last.clientX - event.clientX) * point.scale,
        (touch.last.clientY - event.clientY) * point.scale,
      );
    }
    touch.last = event;
  };
  const releaseMouse = (event: PointerEvent, cancelled: boolean) => {
    let buttons = mouseButtons;
    if (buttons === 0) return;
    mouseButtons = cancelled ? 0 : event.buttons & 7;
    flushMouse();
    flushWheel();
    const point = pagePoint(event.clientX, event.clientY, true);
    if (!point) return;
    for (const bit of [1, 2, 4]) {
      if (!(buttons & bit) || (mouseButtons & bit) !== 0) continue;
      buttons &= ~bit;
      const button = bit === 1 ? "left" : bit === 2 ? "right" : "middle";
      send(mouseInput(event, point, "up", button, buttons));
    }
  };
  const onPointerEnd = (event: PointerEvent) => {
    const cancelled = event.type === "pointercancel";
    if (event.pointerType !== "touch") {
      releaseMouse(event, cancelled);
      return;
    }
    const ended = touch;
    if (!ended || ended.start.pointerId !== event.pointerId) return;
    touch = null;
    const answered = probe;
    if (cancelled || ended.panning) {
      if (answered) answered.end = "panned";
      return;
    }
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    // Focusing inside the tap's user activation is what lets iOS raise the keyboard.
    if (answered?.editable === true) input.focus({ preventScroll: true });
    else if (answered?.editable === false) input.blur();
    if (answered) answered.end = answered.editable === null ? "late" : "acted";
    flushWheel();
    const clickCount = countClick(event, "left");
    const at = { x: point.x, y: point.y, modifiers: 0 };
    send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
    send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
    send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
  };
  // Trackpads and mice on tablets scroll with wheel events.
  const onWheel = (event: WheelEvent) => {
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? (viewport?.height ?? 0)
          : 1;
    queueWheel(point, event.deltaX * unit, event.deltaY * unit);
  };
  // Keeps focus in the page input and stops native selection and callouts.
  const preventDefault = (event: Event) => event.preventDefault();

  const onKey = (action: "down" | "up", event: KeyboardEvent) => {
    if (control?.controller !== "you") return;
    // IME and soft keyboards deliver text through composition and input events.
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    ) {
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    // Paste arrives as input text from this device's clipboard. Copy and cut run in
    // the page, which sends the copied text back. Shift+Insert is the same paste.
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    // Enter carries "\r" like Puppeteer's key table, so forms submit and textareas break lines.
    const text = shortcut
      ? undefined
      : [...event.key].length === 1
        ? event.key
        : event.key === "Enter"
          ? "\r"
          : undefined;
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && text !== undefined ? { text } : {}),
      modifiers: previewStreamModifiers(event),
    });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    // Shortcuts keep their default, so a paste still arrives as text.
    keySent =
      action === "down" &&
      !shortcut &&
      (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    if (!shortcut) event.preventDefault();
  };
  const resetInput = () => {
    input.value = SENTINEL;
    input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const pressKey = (key: "Backspace" | "Delete", keyCode: number) => {
    for (const action of ["down", "up"] as const) {
      send({ type: "key", action, key, code: key, keyCode, modifiers: 0 });
    }
  };
  const onInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const inputType = event instanceof InputEvent ? event.inputType : "";
    if (keySent) keySent = false;
    else if (inputType === "deleteContentBackward") pressKey("Backspace", 8);
    else if (inputType === "deleteContentForward") pressKey("Delete", 46);
    else {
      const value = input.value;
      const text = value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : value;
      if (text) send({ type: "text", text });
    }
    resetInput();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    const text = event.data.startsWith(SENTINEL) ? event.data.slice(SENTINEL.length) : event.data;
    if (text) send({ type: "text", text });
    resetInput();
  };

  if (interactive) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", preventDefault);
    canvas.addEventListener("contextmenu", preventDefault);
    input.addEventListener("keydown", (event) => onKey("down", event));
    input.addEventListener("keyup", (event) => onKey("up", event));
    input.addEventListener("input", onInput);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("focus", resetInput);
    // Copying the input would put its sentinel on this device's clipboard.
    input.addEventListener("copy", preventDefault);
    input.addEventListener("cut", preventDefault);
    resetInput();
  }

  // WebKit reports no support on a video that has not loaded yet; check the prototype.
  const videoPrototype: PresentationVideo = HTMLVideoElement.prototype;
  const pictureInPictureSupported =
    interactive &&
    typeof canvas.captureStream === "function" &&
    typeof CanvasCaptureMediaStreamTrack === "function" &&
    ((document.pictureInPictureEnabled === true &&
      typeof videoPrototype.requestPictureInPicture === "function") ||
      typeof videoPrototype.webkitSetPresentationMode === "function");
  // Since the iOS 17 SDK, WebKit revokes the activation it grants an injected script when
  // the script returns, so the native button's request must start before any await. The
  // video is ready ahead of the tap: paused, and fed a frame only when it has none or
  // floats, so the inline view captures nothing.
  let video: PresentationVideo | null = null;
  let track: CanvasCaptureMediaStreamTrack | null = null;
  const pictureInPictureActive = () =>
    video !== null &&
    (document.pictureInPictureElement === video ||
      video.webkitPresentationMode === "picture-in-picture");
  const reportPictureInPicture = (detail?: string) =>
    post({
      type: "pictureInPicture",
      supported: pictureInPictureSupported,
      active: pictureInPictureActive(),
      ...(detail ? { detail } : {}),
    });
  // Called after each paint. A frame drawn before the player attached is lost, so retry.
  const sendPictureInPictureFrame = () => {
    if (video && (video.readyState === HTMLMediaElement.HAVE_NOTHING || pictureInPictureActive())) {
      track?.requestFrame();
    }
  };
  if (pictureInPictureSupported) {
    const stream = canvas.captureStream(0);
    const [captured] = stream.getVideoTracks();
    const element: PresentationVideo = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    // Under the canvas at full size: WebKit pauses muted video it considers off screen.
    element.srcObject = stream;
    for (const name of [
      "enterpictureinpicture",
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
    ]) {
      element.addEventListener(name, () => {
        if (!pictureInPictureActive()) element.pause();
        reportPictureInPicture();
      });
    }
    container.prepend(element);
    // Covers the letterbox, where a stale frame of another shape would show through.
    canvas.style.background = configuration.background;
    video = element;
    track = captured instanceof CanvasCaptureMediaStreamTrack ? captured : null;
  }
  const togglePictureInPicture = () => {
    const element = video;
    if (!element) return;
    if (pictureInPictureActive()) {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
      else element.webkitSetPresentationMode?.("inline");
      return;
    }
    if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
      reportPictureInPicture("The page has not shown yet. Try again in a moment.");
      return;
    }
    // The page may have changed since the video's last frame. WebKit captures only on a draw.
    track?.requestFrame();
    canvas.getContext("2d")?.drawImage(canvas, 0, 0);
    const fail = (error: unknown) => {
      element.pause();
      reportPictureInPicture(
        error instanceof Error ? error.message : "Picture in picture is unavailable.",
      );
    };
    if (document.pictureInPictureEnabled) {
      const entering = element.requestPictureInPicture();
      void Promise.all([entering, element.play()]).catch(fail);
    } else {
      element.webkitSetPresentationMode?.("picture-in-picture");
      void element.play().catch(fail);
    }
  };

  activeViewer = {
    stop: () => {
      stopped = true;
      observer.disconnect();
      visualViewport?.removeEventListener("resize", followVisualViewport);
      visualViewport?.removeEventListener("scroll", followVisualViewport);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
      if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
      if (agentCursorTimer !== null) clearTimeout(agentCursorTimer);
      painter.stop();
      client?.stop();
      client = null;
      track?.stop();
      if (video) video.srcObject = null;
    },
    command: (message) => {
      send(message);
    },
    togglePictureInPicture,
  };
  window.addEventListener("pagehide", stop, { once: true });
  reportStatus("connecting");
  if (interactive) reportPictureInPicture();
}
