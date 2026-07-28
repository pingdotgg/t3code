export interface ParsedMessageReply {
  readonly referencedText: string;
  readonly messageText: string;
}

const REPLY_ENVELOPE_PREFIX = "[Replying to:";
const OWN_MESSAGE_REPLY_ENVELOPE_PREFIX = "[Replying to your previous message:";
const REPLY_ENVELOPE_PATTERN =
  /^\s*\[Replying to(?: your previous message)?:\s*"([\s\S]*?)"\][ \t]*(?:\r?\n)+([\s\S]+)$/;

/**
 * Hermes transports encode reply metadata in a leading text envelope. Keep
 * this parser deliberately strict so an ordinary message that happens to
 * mention "Replying to" is not reformatted.
 */
export function extractLeadingMessageReply(text: string): ParsedMessageReply | null {
  const trimmedStart = text.trimStart();
  if (
    !trimmedStart.startsWith(REPLY_ENVELOPE_PREFIX) &&
    !trimmedStart.startsWith(OWN_MESSAGE_REPLY_ENVELOPE_PREFIX)
  ) {
    return null;
  }

  const match = REPLY_ENVELOPE_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  const referencedText = (match[1] ?? "").trim();
  const messageText = (match[2] ?? "").trim();
  if (referencedText.length === 0 || messageText.length === 0) {
    return null;
  }

  return { referencedText, messageText };
}
