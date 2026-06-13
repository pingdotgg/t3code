import { diffWordsWithSpace } from "diff";

import type { ReviewHighlightedToken } from "./shikiReviewHighlighter";

interface ReviewDiffOperation {
  readonly value: string;
  readonly added?: true;
  readonly removed?: true;
}

interface ReviewDiffHighlightRange {
  readonly start: number;
  readonly end: number;
}

const REVIEW_MAX_WORD_ALT_LINE_LENGTH = 1_000;

function cleanLineEnding(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function pushOrJoinSpan(input: {
  readonly operation: ReviewDiffOperation;
  readonly spans: Array<[0 | 1, string]>;
  readonly enableJoin: boolean;
  readonly isNeutral?: boolean;
  readonly isLastOperation?: boolean;
}): void {
  const { operation, spans, enableJoin, isNeutral = false, isLastOperation = false } = input;
  const lastSpan = spans.at(-1);

  if (!lastSpan || isLastOperation || !enableJoin) {
    spans.push([isNeutral ? 0 : 1, operation.value]);
    return;
  }

  const lastSpanIsNeutral = lastSpan[0] === 0;
  if (
    isNeutral === lastSpanIsNeutral ||
    (isNeutral && operation.value.length === 1 && !lastSpanIsNeutral)
  ) {
    lastSpan[1] += operation.value;
    return;
  }

  spans.push([isNeutral ? 0 : 1, operation.value]);
}

function spansToRanges(
  spans: ReadonlyArray<readonly [0 | 1, string]>,
): ReadonlyArray<ReviewDiffHighlightRange> {
  const ranges: ReviewDiffHighlightRange[] = [];
  let offset = 0;

  spans.forEach(([kind, value]) => {
    const nextOffset = offset + value.length;
    if (kind === 1 && value.length > 0) {
      ranges.push({ start: offset, end: nextOffset });
    }
    offset = nextOffset;
  });

  return ranges;
}

function mergeNearbyRanges(
  ranges: ReadonlyArray<ReviewDiffHighlightRange>,
): ReadonlyArray<ReviewDiffHighlightRange> {
  if (ranges.length <= 1) {
    return ranges;
  }

  const merged: ReviewDiffHighlightRange[] = [];

  ranges.forEach((range) => {
    const previous = merged.at(-1);
    if (previous && range.start - previous.end <= 1) {
      merged[merged.length - 1] = { start: previous.start, end: range.end };
      return;
    }
    merged.push({ ...range });
  });

  return merged;
}

function appendTokenSegment(
  target: ReviewHighlightedToken[],
  source: ReviewHighlightedToken,
  content: string,
  diffHighlight: boolean,
): void {
  if (content.length === 0) {
    return;
  }

  const previous = target.at(-1);
  if (
    previous &&
    previous.color === source.color &&
    previous.fontStyle === source.fontStyle &&
    previous.diffHighlight === diffHighlight
  ) {
    previous.content += content;
    return;
  }

  target.push({
    content,
    color: source.color,
    fontStyle: source.fontStyle,
    diffHighlight,
  });
}

export function computeWordAltDiffRanges(input: {
  readonly deletionLine: string;
  readonly additionLine: string;
}): {
  readonly deletion: ReadonlyArray<ReviewDiffHighlightRange>;
  readonly addition: ReadonlyArray<ReviewDiffHighlightRange>;
} {
  const deletionLine = cleanLineEnding(input.deletionLine);
  const additionLine = cleanLineEnding(input.additionLine);

  if (deletionLine.length === 0 && additionLine.length === 0) {
    return { deletion: [], addition: [] };
  }

  if (
    deletionLine.length > REVIEW_MAX_WORD_ALT_LINE_LENGTH ||
    additionLine.length > REVIEW_MAX_WORD_ALT_LINE_LENGTH
  ) {
    return { deletion: [], addition: [] };
  }

  const operations = diffWordsWithSpace(
    deletionLine,
    additionLine,
  ) as ReadonlyArray<ReviewDiffOperation>;
  const deletionSpans: Array<[0 | 1, string]> = [];
  const additionSpans: Array<[0 | 1, string]> = [];
  const lastOperation = operations.at(-1);

  operations.forEach((operation) => {
    const isLastOperation = operation === lastOperation;
    if (!operation.added && !operation.removed) {
      pushOrJoinSpan({
        operation,
        spans: deletionSpans,
        enableJoin: true,
        isNeutral: true,
        isLastOperation,
      });
      pushOrJoinSpan({
        operation,
        spans: additionSpans,
        enableJoin: true,
        isNeutral: true,
        isLastOperation,
      });
      return;
    }

    if (operation.removed) {
      pushOrJoinSpan({
        operation,
        spans: deletionSpans,
        enableJoin: true,
        isLastOperation,
      });
      return;
    }

    pushOrJoinSpan({
      operation,
      spans: additionSpans,
      enableJoin: true,
      isLastOperation,
    });
  });

  return {
    deletion: mergeNearbyRanges(spansToRanges(deletionSpans)),
    addition: mergeNearbyRanges(spansToRanges(additionSpans)),
  };
}

export function applyDiffRangesToTokens(
  tokens: ReadonlyArray<ReviewHighlightedToken>,
  ranges: ReadonlyArray<ReviewDiffHighlightRange>,
): ReadonlyArray<ReviewHighlightedToken> {
  if (tokens.length === 0 || ranges.length === 0) {
    return tokens;
  }

  const nextTokens: ReviewHighlightedToken[] = [];
  let tokenOffset = 0;
  let rangeIndex = 0;

  tokens.forEach((token) => {
    const tokenStart = tokenOffset;
    const tokenEnd = tokenStart + token.content.length;
    tokenOffset = tokenEnd;

    if (token.content.length === 0) {
      nextTokens.push(token);
      return;
    }

    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= tokenStart) {
      rangeIndex += 1;
    }

    if ((ranges[rangeIndex]?.start ?? Number.POSITIVE_INFINITY) >= tokenEnd) {
      nextTokens.push(token.diffHighlight ? { ...token, diffHighlight: false } : token);
      return;
    }

    let cursor = tokenStart;
    let localRangeIndex = rangeIndex;

    while ((ranges[localRangeIndex]?.start ?? Number.POSITIVE_INFINITY) < tokenEnd) {
      const range = ranges[localRangeIndex];
      if (!range) {
        break;
      }

      if (range.start > cursor) {
        appendTokenSegment(
          nextTokens,
          token,
          token.content.slice(cursor - tokenStart, range.start - tokenStart),
          false,
        );
      }

      const highlightedStart = Math.max(cursor, range.start);
      const highlightedEnd = Math.min(tokenEnd, range.end);

      if (highlightedEnd > highlightedStart) {
        appendTokenSegment(
          nextTokens,
          token,
          token.content.slice(highlightedStart - tokenStart, highlightedEnd - tokenStart),
          true,
        );
      }

      cursor = highlightedEnd;
      if (range.end <= tokenEnd) {
        localRangeIndex += 1;
      } else {
        break;
      }
    }

    if (cursor < tokenEnd) {
      appendTokenSegment(nextTokens, token, token.content.slice(cursor - tokenStart), false);
    }

    rangeIndex = localRangeIndex;
  });

  return nextTokens;
}
