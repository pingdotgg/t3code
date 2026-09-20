import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewRecordingInput,
} from "@t3tools/contracts";

import {
  DEFAULT_RECORDING_INPUT_OPTIONS,
  recordingKeyLabel,
  recordingKeysAreSensitive,
  type RecordingInputOptions,
  type RecordingKeyPress,
} from "./RecordingInput.ts";

/**
 * Chromium's capture cursor uses native window bounds, which do not follow a
 * webview's CSS placement or scale. Draw it in the guest's coordinate space
 * while recording, and make the native cursor transparent to avoid two cursors.
 */
export function installRecordingCursor(
  document: Document,
  window: Window,
  options: RecordingInputOptions = DEFAULT_RECORDING_INPUT_OPTIONS,
  emit: (input: DesktopPreviewRecordingInput) => void = () => {},
) {
  const style = document.createElement("style");
  style.textContent =
    "html, html * { cursor: none !important; } @media (prefers-reduced-motion: reduce) { [data-t3code-recording-agent-cursor] { transition: none !important; } }";
  const cursor = document.createElement("div");
  cursor.setAttribute("aria-hidden", "true");
  cursor.setAttribute("data-t3code-recording-cursor", "");
  cursor.style.cssText =
    "position:fixed;left:0;top:0;width:16px;height:24px;pointer-events:none;z-index:2147483647;display:none;";
  cursor.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24" viewBox="0 0 16 24"><path d="M1 1v18l4-4 4 8 3-1.5-4-8H15Z" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const agentCursor = document.createElement("div");
  agentCursor.setAttribute("aria-hidden", "true");
  agentCursor.setAttribute("data-t3code-recording-agent-cursor", "");
  agentCursor.style.cssText =
    "position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;display:none;filter:drop-shadow(0 1px 2px #0003);transition:transform 150ms ease-out,opacity 150ms ease-out;";
  // Match the MousePointer2 icon used by the live AgentBrowserCursor.
  agentCursor.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="var(--recording-cursor-background,white)" stroke="var(--recording-cursor-primary,#2563eb)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:translate(-2px,-2px)"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>';
  document.documentElement.append(style, cursor, agentCursor);
  let controller: "human" | "agent" | "none" = "none";
  let humanPoint: { readonly x: number; readonly y: number } | null = null;
  const drawHuman = () => {
    if (!humanPoint) return;
    cursor.style.transform = `translate(${humanPoint.x}px, ${humanPoint.y}px)`;
    cursor.style.display = "block";
  };
  let agentActive = false;
  let agentTimer: number | undefined;
  const setController = (
    next: typeof controller,
    point?: { readonly x: number; readonly y: number },
  ) => {
    if (point) humanPoint = point;
    controller = next;
    if (next === "agent") cursor.style.display = "none";
    if (next === "human") drawHuman();
    if (!agentActive) agentCursor.style.opacity = next === "human" ? "0.18" : "0.35";
  };
  const setTheme = (
    theme: Pick<DesktopPreviewAnnotationTheme, "primary" | "background"> | null,
  ) => {
    agentCursor.style.setProperty("--recording-cursor-primary", theme?.primary ?? "#2563eb");
    agentCursor.style.setProperty("--recording-cursor-background", theme?.background ?? "white");
  };
  let lastKeyLabel: string | null = null;
  let pointerHeld = false;
  let pointerFrame: number | undefined;
  let pendingPointer: DesktopPreviewRecordingInput | undefined;
  const cancelPendingPointer = () => {
    if (pointerFrame !== undefined) window.cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pendingPointer = undefined;
  };
  const keyPress = (input: RecordingKeyPress, held = false) => {
    if (!options.showKeyPresses) return;
    const label = recordingKeysAreSensitive(document)
      ? null
      : recordingKeyLabel(input, /Mac/.test(window.navigator.platform));
    lastKeyLabel = label;
    emit({ type: "key", label, held, width: window.innerWidth });
  };
  const pointer = (
    point: { readonly x: number; readonly y: number },
    phase: "move" | "down" | "up" | "click",
  ) => {
    if (!options.showMousePresses || (phase === "move" && !pointerHeld)) return;
    if (phase === "down") pointerHeld = true;
    if (phase === "up") pointerHeld = false;
    const input: DesktopPreviewRecordingInput = {
      type: "pointer",
      phase,
      ...point,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    if (phase === "move") {
      pendingPointer = input;
      pointerFrame ??= window.requestAnimationFrame(() => {
        pointerFrame = undefined;
        if (pendingPointer) emit(pendingPointer);
        pendingPointer = undefined;
      });
    } else {
      cancelPendingPointer();
      emit(input);
    }
  };
  const move = (
    point: { readonly x: number; readonly y: number },
    phase: "move" | "click" = "move",
  ) => {
    agentCursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    agentCursor.style.display = "block";
    agentCursor.style.opacity = "1";
    agentActive = true;
    window.clearTimeout(agentTimer);
    agentTimer = window.setTimeout(() => {
      agentActive = false;
      agentCursor.style.opacity = controller === "human" ? "0.18" : "0.35";
    }, 700);
    pointer(point, phase);
  };
  const moveHuman = (point: { readonly x: number; readonly y: number }) => {
    if (controller === "agent") return;
    humanPoint = point;
    drawHuman();
  };
  const pointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const point = { x: event.clientX, y: event.clientY };
    moveHuman(point);
    pointer(point, "move");
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    moveHuman({ x: event.clientX, y: event.clientY });
    pointer({ x: event.clientX, y: event.clientY }, "down");
  };
  const pointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "touch") pointer({ x: event.clientX, y: event.clientY }, "up");
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.repeat) return;
    keyPress(event, true);
  };
  const keyUp = () => {
    if (!options.showKeyPresses) return;
    emit({
      type: "key",
      label: recordingKeysAreSensitive(document) ? null : lastKeyLabel,
      held: false,
      width: window.innerWidth,
    });
  };
  const hide = () => {
    cursor.style.display = "none";
    pointerHeld = false;
    cancelPendingPointer();
    if (options.showKeyPresses || options.showMousePresses) emit({ type: "clear" });
  };
  const leave = (event: PointerEvent) => {
    if (event.relatedTarget === null) hide();
  };
  window.addEventListener("pointermove", pointerMove, true);
  window.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointerup", pointerUp, true);
  window.addEventListener("pointercancel", pointerUp, true);
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("pointerout", leave, true);
  window.addEventListener("blur", hide);
  return {
    move,
    keyPress,
    setController,
    setTheme,
    dispose: () => {
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerUp, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp, true);
      window.removeEventListener("pointerout", leave, true);
      window.removeEventListener("blur", hide);
      cancelPendingPointer();
      window.clearTimeout(agentTimer);
      cursor.remove();
      agentCursor.remove();
      style.remove();
    },
  };
}
