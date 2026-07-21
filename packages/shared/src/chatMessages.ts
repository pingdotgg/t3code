export const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
export const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

/** Keep long prompts from dominating the conversation timeline. */
export function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) return false;
  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}
