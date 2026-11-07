const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const SPOKEN = /[\p{L}\p{N}]/u;

/**
 * Splits text into pieces Kokoro renders in one pass. Its tokenizer silently truncates
 * past 510 phonemes, so long sentences break at a clause or a space.
 */
export function splitSentences(text: string, maxChars = 300): string[] {
  const pieces: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    let rest = segment.trim();
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars);
      const clause = Math.max(...[", ", "; ", ": "].map((mark) => window.lastIndexOf(mark)));
      const space = window.lastIndexOf(" ");
      const at = clause > maxChars / 3 ? clause + 1 : space > 0 ? space : maxChars;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  return pieces.filter((piece) => SPOKEN.test(piece));
}
