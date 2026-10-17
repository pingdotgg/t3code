import type { PreviewAnnotationSubmission } from "@t3tools/contracts";

interface AnnotationKeyboardEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

export function handleAnnotationKeyEvent(
  event: AnnotationKeyboardEvent &
    Pick<
      KeyboardEvent,
      | "type"
      | "target"
      | "isTrusted"
      | "preventDefault"
      | "stopImmediatePropagation"
      | "stopPropagation"
    >,
  input: {
    overlayTarget: EventTarget;
    commentFocused: boolean;
    canSend: boolean;
  },
): "cancel" | "select" | "marquee" | "draw" | "erase" | PreviewAnnotationSubmission | null {
  const inOverlay = event.target === input.overlayTarget;
  if (inOverlay) event.stopImmediatePropagation();
  // Page scripts can target the visible shadow host without accessing the editor.
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
