import { ComposerContextId } from "@t3tools/contracts";
import type { ComposerContextClipboardFragment } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { isClosingFence, parseOpeningFence } from "~/composer-rich-text-doc";

/**
 * Code ranges by the composer's rules: fences open and close only on their own line, and a
 * backtick run spans to the next run of its length on that line. Linear in the text length.
 */
function markdownCodeRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const lines = text.split("\n");
  let lineStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opening = parseOpeningFence(line);
    if (opening) {
      const fenceStart = lineStart;
      do {
        lineStart += lines[index]!.length + 1;
        index += 1;
      } while (index < lines.length && !isClosingFence(lines[index]!, opening.fence));
      ranges.push([fenceStart, Math.min(text.length, lineStart + (lines[index]?.length ?? 0))]);
    } else {
      pushCodeSpans(line, lineStart, ranges);
    }
    lineStart += (lines[index]?.length ?? 0) + 1;
  }
  return ranges;
}

function pushCodeSpans(line: string, offset: number, ranges: Array<readonly [number, number]>) {
  const runs = Array.from(line.matchAll(/`+/g), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  // Run indexes by length, each with a cursor that only moves forward.
  const byLength = new Map<number, { indexes: number[]; next: number }>();
  runs.forEach((run, index) => {
    const entry = byLength.get(run.end - run.start) ?? { indexes: [], next: 0 };
    entry.indexes.push(index);
    byLength.set(run.end - run.start, entry);
  });
  let codeEnd = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    let backslashes = 0;
    while (run.start - backslashes > codeEnd && line[run.start - backslashes - 1] === "\\") {
      backslashes += 1;
    }
    // An escaped backtick is literal and the rest of its run may still open.
    const start = run.start + (backslashes % 2);
    const candidates = byLength.get(run.end - start);
    if (!candidates) continue;
    while (
      candidates.next < candidates.indexes.length &&
      candidates.indexes[candidates.next]! <= index
    ) {
      candidates.next += 1;
    }
    const closeIndex = candidates.indexes[candidates.next];
    if (closeIndex === undefined) continue;
    ranges.push([offset + start, offset + runs[closeIndex]!.end]);
    codeEnd = runs[closeIndex]!.end;
    index = closeIndex;
  }
}

/** Whether an offset is inside code; call it with ascending offsets. */
function codeOffsetTest(text: string): (offset: number) => boolean {
  let ranges: Array<readonly [number, number]> | null = null;
  let next = 0;
  return (offset) => {
    ranges ??= markdownCodeRanges(text);
    while (next < ranges.length && ranges[next]![1] <= offset) next += 1;
    return next < ranges.length && ranges[next]![0] <= offset;
  };
}

export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const pastedText = clipboardData.getData("text/plain");
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  if (decodedFragment === null) return null;
  const inCode = codeOffsetTest(pastedText);
  const pastedIds = new Set<string>(
    collectComposerContextReferences(pastedText)
      .filter((occurrence) => !inCode(occurrence.start))
      .map((occurrence) => occurrence.contextId),
  );
  for (const record of decodedFragment.records) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
  }
  return {
    ...decodedFragment,
    records: decodedFragment.records.filter((record) => pastedIds.has(record.contextId)),
  };
}

/**
 * References with no record behind them, in the paste or the draft, paste as their label.
 * References inside code stay as written.
 */
export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string | null>,
  heldContextIds: Pick<ReadonlySet<string>, "has"> = new Set(),
): string {
  const pastedText = clipboardData.getData("text/plain");
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
  const inCode = codeOffsetTest(pastedText);
  return replaceComposerContextReferences(pastedText, (occurrence) => {
    if (inCode(occurrence.start)) return occurrence.source;
    const nextId = rewrittenIds?.get(occurrence.contextId);
    if (nextId) {
      return formatComposerContextReference({
        ...occurrence,
        contextId: ComposerContextId.make(nextId),
        kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
      });
    }
    return nextId !== null && heldContextIds.has(occurrence.contextId)
      ? occurrence.source
      : occurrence.label;
  });
}
