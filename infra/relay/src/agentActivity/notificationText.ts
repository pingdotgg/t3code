const encoder = new TextEncoder();
export const jsonByteLength = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).length;

/** Fit the actual encoded payload; prefer a complete sentence over a cut word. */
export function fitNotificationText(text: string, fits: (text: string) => boolean): string {
  if (fits(text)) return text;
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join("").trimEnd() + "…")) low = middle;
    else high = middle - 1;
  }
  const prefix = characters.slice(0, low).join("").trimEnd();
  let sentenceEnd = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)) {
    const end = part.index + part.segment.trimEnd().length;
    if (end > prefix.length) break;
    sentenceEnd = end;
  }
  const excerpt = sentenceEnd > 0 ? text.slice(0, sentenceEnd) : prefix;
  return fits(excerpt + "…") ? excerpt + "…" : "";
}
