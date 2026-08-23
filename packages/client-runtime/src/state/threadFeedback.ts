export function parseCodexFeedbackCommand(text: string): { readonly reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) {
    return null;
  }
  const reason = match[1]?.trim();
  return reason ? { reason } : {};
}
