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

// Fences, then code spans, as threadLinks reads them: a reference inside one is literal text.
const MARKDOWN_CODE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\n]*?\2/g;

/** Whether an offset is inside code; call it with ascending offsets. */
function codeOffsetTest(text: string): (offset: number) => boolean {
  let ranges: Array<readonly [number, number]> | null = null;
  let next = 0;
  return (offset) => {
    ranges ??= Array.from(text.matchAll(MARKDOWN_CODE), (match) => [
      match.index,
      match.index + match[0].length,
    ]);
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
