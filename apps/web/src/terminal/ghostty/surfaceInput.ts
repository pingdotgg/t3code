import { isMacPlatform } from "../../lib/utils";

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  const key = event.key.toLowerCase();
  if (key === "insert" && !isMacPlatform(platform)) {
    return event.ctrlKey && !event.shiftKey && !event.metaKey;
  }
  if (key !== "c") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

/** Primes native and Electron menu copy from the focused textarea; canvas has no DOM selection. */
export function primeTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, "value" | "select">,
  selection: string,
): void {
  input.value = selection;
  if (selection.length === 0) return;
  input.select();
}

export function clearPrimedTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, "value">,
  primedSelection: string,
): void {
  // Only clear the parked copy; other text may be an active CJK composition.
  if (primedSelection.length === 0 || input.value !== primedSelection) return;
  input.value = "";
}

export function applyTerminalCopyEvent(
  selection: string,
  clipboardData: { setData: (type: string, data: string) => void } | null | undefined,
): { preventDefault: boolean; claimWriteFallback: boolean } {
  if (selection.length === 0 || !clipboardData) {
    return { preventDefault: false, claimWriteFallback: false };
  }
  clipboardData.setData("text/plain", selection);
  return { preventDefault: true, claimWriteFallback: true };
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  const key = event.key.toLowerCase();
  if (key === "insert" && !isMacPlatform(platform)) {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }
  if (key !== "v") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

// X11/Wayland expects middle-click paste; macOS and Windows use it for autoscroll.
export function isMiddleClickPastePlatform(): boolean {
  return /linux|bsd/i.test(navigator.platform);
}

export function isTerminalCompositionCommitInput(event: Pick<InputEvent, "inputType">): boolean {
  return (
    event.inputType === "" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition"
  );
}

export function isTerminalCompositionKey(
  event: Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">,
  composing: boolean,
): boolean {
  return event.isComposing || composing || event.key === "Process" || event.keyCode === 229;
}

export function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, "getModifierState" | "key">,
): boolean {
  return event.getModifierState("AltGraph") && [...event.key].length === 1;
}

export function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

export type TerminalMouseAction = "press" | "release" | "motion";

export function resolveTerminalMouseData(
  action: TerminalMouseAction,
  data: string,
  previousMotionData: string,
): { readonly send: boolean; readonly nextMotionData: string } {
  const nextMotionData = action === "motion" ? data : "";
  return {
    send: data.length > 0 && (action !== "motion" || data !== previousMotionData),
    nextMotionData,
  };
}

export function resolveTerminalMouseTrackingState(
  previousTracking: boolean,
  tracking: boolean,
  motionData: string,
): { readonly tracking: boolean; readonly motionData: string } {
  return {
    tracking,
    motionData: previousTracking === tracking ? motionData : "",
  };
}

export function terminalWheelDeltaRows(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  cellHeight: number,
  viewportRows: number,
  remainder: number,
): { readonly rows: number; readonly remainder: number } {
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * cellHeight
      : event.deltaMode === 2
        ? event.deltaY * viewportRows * cellHeight
        : event.deltaY;
  const total = remainder + pixels / cellHeight;
  const rows = Math.trunc(total);
  return { rows, remainder: total - rows };
}

// Ramp from 1 to 15 rows per autoscroll tick over the first 50px past the edge, as xterm.js does.
export const SELECTION_AUTOSCROLL_RAMP_PX = 50;
export const SELECTION_AUTOSCROLL_MAX_ROWS = 15;

export function terminalSelectionAutoscrollRows(
  clientY: number,
  top: number,
  bottom: number,
): number {
  const distance = clientY < top ? clientY - top : clientY > bottom ? clientY - bottom : 0;
  if (distance === 0) return 0;
  const ramp = Math.max(-1, Math.min(1, distance / SELECTION_AUTOSCROLL_RAMP_PX));
  return Math.sign(ramp) + Math.round(ramp * (SELECTION_AUTOSCROLL_MAX_ROWS - 1));
}

export function terminalWheelArrowData(rows: number, applicationCursorKeys: boolean): string {
  if (rows === 0) return "";
  const sequence =
    rows < 0
      ? applicationCursorKeys
        ? "\u001bOA"
        : "\u001b[A"
      : applicationCursorKeys
        ? "\u001bOB"
        : "\u001b[B";
  return sequence.repeat(Math.abs(rows));
}

export function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return null;
  }
}
