const ASSISTANT_RESPONSE_QUOTE_LABEL = "Replying to an assistant response:";

export function formatAssistantResponseQuote(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return [
    `> **${ASSISTANT_RESPONSE_QUOTE_LABEL}**`,
    ">",
    ...trimmed.split("\n").map((line) => `> ${line}`),
  ].join("\n");
}

export function buildAssistantResponseQuoteInsertion(prompt: string, text: string): string | null {
  const quote = formatAssistantResponseQuote(text);
  if (!quote) return null;

  const separator =
    prompt.length === 0 ? "" : prompt.endsWith("\n\n") ? "" : prompt.endsWith("\n") ? "\n" : "\n\n";
  return `${separator}${quote}\n\n`;
}
