export function shouldIgnoreChatGlobalShortcutEvent(
  event: Pick<KeyboardEvent, "defaultPrevented" | "repeat">,
): boolean {
  return event.defaultPrevented || event.repeat;
}
