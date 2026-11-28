import type { SpeechSynthesisWord } from "@t3tools/contracts";

/** The whitespace-separated words of `text`, as UTF-16 offsets. */
export function textWords(text: string) {
  return [...text.matchAll(/\S+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Spreads words over `durationSeconds` by length, with longer pauses after punctuation. The
 * fallback when no word timings exist for a stretch of audio.
 */
export function estimateWords(
  text: string,
  words: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  startSeconds: number,
  endSeconds: number,
): SpeechSynthesisWord[] {
  const weights = words.map(({ start, end }) => {
    const word = text.slice(start, end);
    return (
      word.length + 1 + (/[.!?。！？]$/u.test(word) ? 4 : /[,;:，、；：]$/u.test(word) ? 2 : 0)
    );
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const span = Math.max(endSeconds - startSeconds, 0);
  let elapsed = 0;
  return words.map((word, index) => {
    const start = startSeconds + (elapsed / total) * span;
    elapsed += weights[index]!;
    return { ...word, startSeconds: start, endSeconds: startSeconds + (elapsed / total) * span };
  });
}
