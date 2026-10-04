import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamInput,
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

interface Viewer {
  readonly stop: () => void;
  readonly command: (input: PreviewStreamInput) => void;
  readonly togglePictureInPicture: () => Promise<void>;
}

let activeViewer: Viewer | null = null;

export function stop() {
  activeViewer?.stop();
  activeViewer = null;
}

/** Navigation and history from the native chrome. Waits for the socket if it is not open yet. */
export function command(input: PreviewStreamInput) {
  activeViewer?.command(input);
}

export function pictureInPicture() {
  void activeViewer?.togglePictureInPicture();
}

/**
 * Bundled into a native WebView without React or Expo's web runtime. Draws a
 * server tab's JPEG frames into a letterboxed canvas. Interactive viewers turn
 * taps into clicks, drags into wheel scrolls, and soft keyboard input into key
 * and text messages, and resize fill-mode tabs to the view.
 */
export function start(configuration: PreviewStreamConfiguration) {
  stop();
  const post = (message: PreviewStreamMessage) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const { interactive } = configuration;
  Object.assign(document.documentElement.style, { height: "100%", overflow: "hidden" });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    overflow: "hidden",
    background: configuration.background,
  });
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  });
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Browser page");
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTouchCallout: "none",
  });
  container.append(canvas);
  // Focus target for page keyboard input, visually hidden like `sr-only`. Pinned
  // top-left so focusing it never scrolls; 16px keeps iOS from zooming on focus.
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Browser page input");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  Object.assign(input.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    border: "0",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    fontSize: "16px",
  });
  document.body.replaceChildren(container, ...(interactive ? [input] : []));

  let stopped = false;
  let streaming = false;
  let viewport: PreviewStreamViewport | null = null;
  let size: { width: number; height: number } | null = null;
  // Frame cap in device px, fixed per socket. It only grows, so only outgrowing it reconnects.
  let cap: { width: number; height: number } | null = null;
  let client: PreviewStreamClient | null = null;
  let pendingCommand: PreviewStreamInput | null = null;
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
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
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
  });
  const send = (message: PreviewStreamInput) => client?.send(message) ?? false;

  const connect = () => {
    client?.stop();
    if (!cap || stopped) return;
    const next = createPreviewStreamClient(
      {
        access: configuration.access,
        threadId: configuration.threadId,
        tabId: configuration.tabId,
        maxWidth: cap.width,
        maxHeight: cap.height,
      },
      {
        onFrame: (jpeg) => painter.paint(jpeg),
        onViewport: (page) => {
          if (viewport?.width === page.width && viewport.height === page.height) return;
          viewport = page;
          post({ type: "viewport", width: page.width, height: page.height });
        },
        onProbe: (result) => {
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
        onConnectedChange: (connected) => {
          if (!connected) {
            if (streaming) reportStatus("connecting");
            return;
          }
          if (interactive && size) next.send({ type: "resize", ...size });
          const queued = pendingCommand;
          pendingCommand = null;
          if (queued) next.send(queued);
        },
        onUnauthorized: () => post({ type: "unauthorized" }),
        onGone: () => post({ type: "gone" }),
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

  const pagePoint = (clientX: number, clientY: number, clamp: boolean) => {
    if (!viewport || canvas.width === 0 || canvas.height === 0) return null;
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
  const onPointerDown = (event: PointerEvent) => {
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
      const clickCount = countClick(event, button);
      mouseClicks[button] = clickCount;
      send({
        type: "mouse",
        action: "down",
        x: point.x,
        y: point.y,
        button,
        buttons: event.buttons,
        clickCount,
        modifiers: previewStreamModifiers(event),
      });
      return;
    }
    touch = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      panning: false,
    };
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
          send({
            type: "mouse",
            action: down ? "down" : "up",
            x: point.x,
            y: point.y,
            button,
            buttons: mouseButtons,
            clickCount: mouseClicks[button],
            modifiers: previewStreamModifiers(event),
          });
        }
      }
      pendingMouse = {
        type: "mouse",
        action: "move",
        x: point.x,
        y: point.y,
        button:
          mouseButtons & 1
            ? "left"
            : mouseButtons & 2
              ? "right"
              : mouseButtons & 4
                ? "middle"
                : "none",
        buttons: event.buttons,
        clickCount: 0,
        modifiers: previewStreamModifiers(event),
      };
      mouseFrame ??= requestAnimationFrame(flushMouse);
      return;
    }
    if (!touch || touch.pointerId !== event.pointerId) return;
    if (
      !touch.panning &&
      Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) < TAP_SLOP_PX
    ) {
      return;
    }
    touch.panning = true;
    const point = pagePoint(event.clientX, event.clientY, true);
    // Dragging the page up scrolls it down, following the finger.
    if (point) {
      queueWheel(
        point,
        (touch.lastX - event.clientX) * point.scale,
        (touch.lastY - event.clientY) * point.scale,
      );
    }
    touch.lastX = event.clientX;
    touch.lastY = event.clientY;
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
      send({
        type: "mouse",
        action: "up",
        x: point.x,
        y: point.y,
        button,
        buttons,
        clickCount: mouseClicks[button],
        modifiers: previewStreamModifiers(event),
      });
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      releaseMouse(event, false);
      return;
    }
    const ended = touch;
    if (!ended || ended.pointerId !== event.pointerId) return;
    touch = null;
    const answered = probe;
    if (ended.panning) {
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
  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      releaseMouse(event, true);
      return;
    }
    if (touch?.pointerId !== event.pointerId) return;
    touch = null;
    if (probe) probe.end = "panned";
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
    // Paste arrives as input text from this device's clipboard. Cut is not forwarded:
    // the page's selection never reaches this clipboard, so it would be lost.
    if (shortcut && ["v", "x"].includes(event.key.toLowerCase())) return;
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
    keySent = action === "down" && !shortcut;
    if (!shortcut) event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent) => onKey("down", event);
  const onKeyUp = (event: KeyboardEvent) => onKey("up", event);
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
      const text = input.value.replaceAll(SENTINEL, "");
      if (text) send({ type: "text", text });
    }
    resetInput();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    const text = event.data.replaceAll(SENTINEL, "");
    if (text) send({ type: "text", text });
    resetInput();
  };

  if (interactive) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", preventDefault);
    canvas.addEventListener("contextmenu", preventDefault);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("input", onInput);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("focus", resetInput);
    // Copying the input would put its sentinel on this device's clipboard.
    input.addEventListener("copy", preventDefault);
    input.addEventListener("cut", preventDefault);
    resetInput();
  }

  // Picture in picture plays the canvas as a muted video. It is created on first
  // use so a viewer that never pops out pays nothing for it.
  // Checks the API, not an element: WebKit reports no support for a video
  // that has not loaded yet.
  const videoPrototype: PresentationVideo = HTMLVideoElement.prototype;
  const pictureInPictureSupported =
    interactive &&
    typeof canvas.captureStream === "function" &&
    ((document.pictureInPictureEnabled === true &&
      typeof videoPrototype.requestPictureInPicture === "function") ||
      typeof videoPrototype.webkitSetPresentationMode === "function");
  let video: PresentationVideo | null = null;
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
  const ensureVideo = () => {
    if (video) return video;
    const element: PresentationVideo = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    element.autoplay = true;
    element.setAttribute("playsinline", "");
    // Under the canvas at full size: WebKit pauses muted video it considers off screen.
    Object.assign(element.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "contain",
      pointerEvents: "none",
    });
    element.srcObject = canvas.captureStream();
    // A static page sends no new frames; repaint once so the stream has one.
    if (canvas.width > 0 && canvas.height > 0) canvas.getContext("2d")?.drawImage(canvas, 0, 0);
    for (const name of [
      "enterpictureinpicture",
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
    ]) {
      element.addEventListener(name, () => {
        // The hidden inline copy stops decoding once the window closes.
        if (!pictureInPictureActive()) element.pause();
        reportPictureInPicture();
      });
    }
    container.prepend(element);
    video = element;
    return element;
  };
  const togglePictureInPicture = async () => {
    if (!pictureInPictureSupported) return;
    try {
      if (pictureInPictureActive()) {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else video?.webkitSetPresentationMode?.("inline");
        return;
      }
      const element = ensureVideo();
      await element.play();
      if (document.pictureInPictureEnabled) await element.requestPictureInPicture();
      else element.webkitSetPresentationMode?.("picture-in-picture");
    } catch (error) {
      reportPictureInPicture(
        error instanceof Error ? error.message : "Picture in picture is unavailable.",
      );
    }
  };

  const viewer: Viewer = {
    stop: () => {
      stopped = true;
      observer.disconnect();
      visualViewport?.removeEventListener("resize", followVisualViewport);
      visualViewport?.removeEventListener("scroll", followVisualViewport);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
      if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
      painter.stop();
      client?.stop();
      client = null;
      if (video) {
        for (const track of video.srcObject instanceof MediaStream
          ? video.srcObject.getTracks()
          : []) {
          track.stop();
        }
        video.srcObject = null;
      }
    },
    command: (message) => {
      if (!send(message)) pendingCommand = message;
    },
    togglePictureInPicture,
  };
  activeViewer = viewer;
  window.addEventListener("pagehide", stop, { once: true });
  reportStatus("connecting");
  if (interactive) reportPictureInPicture();
}
