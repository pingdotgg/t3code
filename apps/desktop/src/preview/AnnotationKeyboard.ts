import type { PreviewAnnotationSubmission } from "@t3tools/contracts";

export type AnnotationTool = "select" | "marquee" | "draw" | "erase";

interface AnnotationKeyboardEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

interface AnnotationKeyEvent extends AnnotationKeyboardEvent {
  readonly type: string;
  readonly target: EventTarget | null;
  readonly isTrusted: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export type AnnotationKeyAction = "cancel" | AnnotationTool | PreviewAnnotationSubmission;

// Runs from the preload's window capture listeners, ahead of any listener the
// inspected page installs. Overlay events are hidden from the page but never
// cancelled, so the editor still receives Space, caret keys and composition.
export function handleAnnotationKeyEvent(
  event: AnnotationKeyEvent,
  input: {
    overlayTarget: EventTarget;
    commentFocused: boolean;
    canSend: boolean;
  },
): AnnotationKeyAction | null {
  const inOverlay = event.target === input.overlayTarget;
  if (inOverlay) event.stopImmediatePropagation();
  // The page can dispatch synthetic key events on the visible shadow host.
  if (event.type !== "keydown" || !event.isTrusted) return null;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    return "cancel";
  }
  if (inOverlay) {
    const submission = input.commentFocused
      ? resolveAnnotationSubmission(event, input.canSend)
      : null;
    if (submission) event.preventDefault();
    return submission;
  }
  // Fixed cases, not a table: the preload shares the page's realm, so an
  // object lookup would also read keys the page planted on Object.prototype.
  switch (event.key) {
    case "v":
      return "select";
    case "r":
      return "marquee";
    case "d":
      return "draw";
    case "e":
      return "erase";
    default:
      return null;
  }
}

export function resolveAnnotationSubmission(
  event: AnnotationKeyboardEvent,
  canSend: boolean,
): PreviewAnnotationSubmission | null {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  return event.metaKey || event.ctrlKey ? (canSend ? "send" : null) : "attach";
}
