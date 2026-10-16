interface CommentSubmitShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export function isCommentSubmitShortcut(
  event: CommentSubmitShortcutEvent,
  value: string,
  pending: boolean,
): boolean {
  return (
    !pending && (event.metaKey || event.ctrlKey) && event.key === "Enter" && value.trim().length > 0
  );
}
