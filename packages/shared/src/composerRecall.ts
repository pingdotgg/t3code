import type { ComposerRecall } from "@t3tools/contracts";

/** Record authored slices before trim, without copying the prompt into metadata. */
export function createComposerRecall(
  text: string,
  authoredRanges: ComposerRecall["ranges"] = [[0, text.length]],
): ComposerRecall {
  const start = text.length - text.trimStart().length;
  const end = start + text.trim().length;
  const ranges: Array<[number, number]> = [];
  let leadingWhitespace = "";
  let trailingWhitespace = "";
  for (const [from, to] of authoredRanges) {
    leadingWhitespace += text.slice(from, Math.min(to, start));
    trailingWhitespace += text.slice(Math.max(from, end), to);
    const keptStart = Math.max(from, start);
    const keptEnd = Math.min(to, end);
    if (keptEnd > keptStart) ranges.push([keptStart - start, keptEnd - start]);
  }
  return {
    ranges,
    ...(leadingWhitespace ? { leadingWhitespace } : {}),
    ...(trailingWhitespace ? { trailingWhitespace } : {}),
  };
}

/** The formatter added a known prefix; appended context does not move kept text. */
export function offsetComposerRecall(recall: ComposerRecall, prefixLength: number): ComposerRecall {
  return {
    ...recall,
    ranges: recall.ranges.map(([start, end]) => [start + prefixLength, end + prefixLength]),
  };
}

export function validComposerRecall(
  text: string,
  recall: ComposerRecall | undefined,
): ComposerRecall | undefined {
  if (recall === undefined) return undefined;
  let previousEnd = 0;
  for (const [start, end] of recall.ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < previousEnd ||
      end < start ||
      end > text.length
    )
      return undefined;
    previousEnd = end;
  }
  if (recall.leadingWhitespace?.trim() || recall.trailingWhitespace?.trim()) return undefined;
  return recall;
}

/** Unknown history is kept verbatim; origin cannot be recovered from matching text. */
export function recallComposerText(message: {
  text: string;
  composerRecall?: ComposerRecall | undefined;
}): string {
  const recall = validComposerRecall(message.text, message.composerRecall);
  if (recall === undefined) return message.text;
  return (
    (recall.leadingWhitespace ?? "") +
    recall.ranges.map(([start, end]) => message.text.slice(start, end)).join("") +
    (recall.trailingWhitespace ?? "")
  );
}
