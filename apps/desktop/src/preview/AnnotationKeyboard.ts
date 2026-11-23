import type { PreviewAnnotationSubmission } from "@t3tools/contracts";

interface AnnotationKeyboardEvent {
  readonly isTrusted: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

export function resolveAnnotationSubmission(
  event: AnnotationKeyboardEvent,
  canSend: boolean,
): PreviewAnnotationSubmission | null {
  if (!event.isTrusted || event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  return event.metaKey || event.ctrlKey ? (canSend ? "send" : null) : "attach";
}
