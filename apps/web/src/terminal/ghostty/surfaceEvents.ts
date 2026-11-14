import { GhosttyTerminalSurface } from "./surface";

export function surfaceInstallEvents(surface: GhosttyTerminalSurface) {
  surface.input.addEventListener("keydown", surface.onKeyDown);
  surface.input.addEventListener("keyup", surface.onKeyUp);
  // App shortcuts stop propagation at window, so observe the same capture target.
  window.addEventListener("keyup", surface.onWindowKeyUp, { capture: true });
  window.addEventListener("keydown", surface.onWindowKeyDown, { capture: true });
  surface.input.addEventListener("focus", surface.onFocus);
  surface.input.addEventListener("blur", surface.onBlur);
  surface.input.addEventListener("input", surface.onInput);
  surface.input.addEventListener("paste", surface.onPaste);
  surface.input.addEventListener("copy", surface.onCopyEvent);
  surface.input.addEventListener("compositionstart", surface.onCompositionStart);
  surface.input.addEventListener("compositionend", surface.onCompositionEnd);
  surface.canvas.addEventListener("pointerdown", surface.onPointerDown);
  surface.canvas.addEventListener("pointermove", surface.onPointerMove);
  surface.canvas.addEventListener("pointerleave", surface.onPointerLeave);
  surface.canvas.addEventListener("pointerup", surface.onPointerUp);
  surface.canvas.addEventListener("pointercancel", surface.onPointerUp);
  surface.canvas.addEventListener("wheel", surface.onWheel, { passive: false });
  surface.canvas.addEventListener("mousedown", surface.onMouseDown);
  surface.canvas.addEventListener("mouseup", surface.onMouseUp);
  surface.canvas.addEventListener("contextmenu", surface.onContextMenu);
  surface.scrollbar.addEventListener("pointerdown", surface.onScrollbarPointerDown);
  surface.scrollbar.addEventListener("pointermove", surface.onScrollbarPointerMove);
  surface.scrollbar.addEventListener("pointerup", surface.onScrollbarPointerUp);
  surface.scrollbar.addEventListener("pointercancel", surface.onScrollbarPointerUp);
  surface.scrollbar.addEventListener("keydown", surface.onScrollbarKeyDown);
  window.addEventListener("pointerup", surface.onWindowPointerRelease);
  window.addEventListener("pointercancel", surface.onWindowPointerRelease);
}

export function surfaceRemoveEvents(surface: GhosttyTerminalSurface) {
  surface.input.removeEventListener("keydown", surface.onKeyDown);
  surface.input.removeEventListener("keyup", surface.onKeyUp);
  window.removeEventListener("keyup", surface.onWindowKeyUp, { capture: true });
  window.removeEventListener("keydown", surface.onWindowKeyDown, { capture: true });
  surface.input.removeEventListener("focus", surface.onFocus);
  surface.input.removeEventListener("blur", surface.onBlur);
  surface.input.removeEventListener("input", surface.onInput);
  surface.input.removeEventListener("paste", surface.onPaste);
  surface.input.removeEventListener("copy", surface.onCopyEvent);
  surface.input.removeEventListener("compositionstart", surface.onCompositionStart);
  surface.input.removeEventListener("compositionend", surface.onCompositionEnd);
  surface.canvas.removeEventListener("pointerdown", surface.onPointerDown);
  surface.canvas.removeEventListener("pointermove", surface.onPointerMove);
  surface.canvas.removeEventListener("pointerleave", surface.onPointerLeave);
  surface.canvas.removeEventListener("pointerup", surface.onPointerUp);
  surface.canvas.removeEventListener("pointercancel", surface.onPointerUp);
  surface.canvas.removeEventListener("wheel", surface.onWheel);
  surface.canvas.removeEventListener("mousedown", surface.onMouseDown);
  surface.canvas.removeEventListener("mouseup", surface.onMouseUp);
  surface.canvas.removeEventListener("contextmenu", surface.onContextMenu);
  surface.scrollbar.removeEventListener("pointerdown", surface.onScrollbarPointerDown);
  surface.scrollbar.removeEventListener("pointermove", surface.onScrollbarPointerMove);
  surface.scrollbar.removeEventListener("pointerup", surface.onScrollbarPointerUp);
  surface.scrollbar.removeEventListener("pointercancel", surface.onScrollbarPointerUp);
  surface.scrollbar.removeEventListener("keydown", surface.onScrollbarKeyDown);
  window.removeEventListener("pointerup", surface.onWindowPointerRelease);
  window.removeEventListener("pointercancel", surface.onWindowPointerRelease);
}
