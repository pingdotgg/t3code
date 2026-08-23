export function formatSpeechInsertion(value: string, cursor: number, transcript: string): string {
  const text = transcript.trim();
  if (!text) return "";
  const before = value[cursor - 1];
  const after = value[cursor];
  const prefix = before && !/\s/.test(before) && !/^\p{P}/u.test(text) ? " " : "";
  const suffix = after && !/\s/.test(after) ? " " : "";
  return `${prefix}${text}${suffix}`;
}
