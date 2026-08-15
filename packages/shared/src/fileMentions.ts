import type { EnvironmentId, ExplicitFileMention } from "@t3tools/contracts";

import { serializeComposerFileLink } from "./composerTrigger.ts";

export type FileMentionValidationFailure = "environment" | "range" | "overlap" | "source";

/** Validates explicit provenance without treating it as a security boundary. */
export function validateExplicitFileMentions(
  text: string,
  mentions: ReadonlyArray<ExplicitFileMention>,
  environmentId?: EnvironmentId,
): FileMentionValidationFailure | null {
  let previousEnd = 0;
  for (const mention of mentions) {
    if (environmentId !== undefined && mention.environmentId !== environmentId) {
      return "environment";
    }
    if (mention.start < 0 || mention.end <= mention.start || mention.end > text.length) {
      return "range";
    }
    if (mention.start < previousEnd) return "overlap";
    if (text.slice(mention.start, mention.end) !== serializeComposerFileLink(mention.path)) {
      return "source";
    }
    previousEnd = mention.end;
  }
  return null;
}

export function replaceTextRangeInFileMentions(
  mentions: ReadonlyArray<ExplicitFileMention>,
  start: number,
  end: number,
  replacementLength: number,
): ExplicitFileMention[] {
  const delta = replacementLength - (end - start);
  const next: ExplicitFileMention[] = [];
  for (const mention of mentions) {
    if (mention.end <= start) {
      next.push(mention);
    } else if (mention.start >= end) {
      next.push({ ...mention, start: mention.start + delta, end: mention.end + delta });
    }
  }
  return next;
}

/** Conservatively maps provenance through a single contiguous text edit. */
export function reconcileFileMentionsAfterEdit(
  previousText: string,
  nextText: string,
  mentions: ReadonlyArray<ExplicitFileMention>,
): ExplicitFileMention[] {
  if (previousText === nextText) return [...mentions];
  let start = 0;
  const prefixLimit = Math.min(previousText.length, nextText.length);
  while (start < prefixLimit && previousText[start] === nextText[start]) start += 1;

  let commonSuffixLength = 0;
  while (
    commonSuffixLength < prefixLimit &&
    previousText[previousText.length - commonSuffixLength - 1] ===
      nextText[nextText.length - commonSuffixLength - 1]
  ) {
    commonSuffixLength += 1;
  }

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  const reconciled = replaceTextRangeInFileMentions(mentions, start, previousEnd, nextEnd - start);
  const ambiguousStart = nextText.length - commonSuffixLength;
  const ambiguousEnd = start;
  if (ambiguousStart >= ambiguousEnd) {
    return reconciled;
  }
  return reconciled.filter(
    (mention) => mention.end <= ambiguousStart || mention.start >= ambiguousEnd,
  );
}

export function shiftFileMentions(
  mentions: ReadonlyArray<ExplicitFileMention>,
  offset: number,
): ExplicitFileMention[] {
  if (offset === 0) return [...mentions];
  return mentions.map((mention) => ({
    ...mention,
    start: mention.start + offset,
    end: mention.end + offset,
  }));
}

export function trimTextWithFileMentions(
  text: string,
  mentions: ReadonlyArray<ExplicitFileMention>,
): { readonly text: string; readonly fileMentions: ExplicitFileMention[] } {
  const trimmed = text.trim();
  const leadingTrim = text.length - text.trimStart().length;
  return {
    text: trimmed,
    fileMentions: mentions.flatMap((mention) => {
      const start = mention.start - leadingTrim;
      const end = mention.end - leadingTrim;
      return start >= 0 && end <= trimmed.length ? [{ ...mention, start, end }] : [];
    }),
  };
}
