const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  let head = trimmed.slice(0, maxLength);
  // Cutting between the halves of a surrogate pair leaves a lone surrogate that renders as U+FFFD.
  if (
    isHighSurrogate(head.charCodeAt(head.length - 1)) &&
    isLowSurrogate(trimmed.charCodeAt(head.length))
  ) {
    head = head.slice(0, -1);
  }
  return `${head}...`;
}
