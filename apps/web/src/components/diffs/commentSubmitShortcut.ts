interface CommentSubmitShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** Shared guard for inline comment composers that submit on Command/Ctrl+Enter. */
export function isCommentSubmitShortcut(
  event: CommentSubmitShortcutEvent,
  value: string,
  pending: boolean,
): boolean {
  return (
    !pending && (event.metaKey || event.ctrlKey) && event.key === "Enter" && value.trim().length > 0
  );
}
