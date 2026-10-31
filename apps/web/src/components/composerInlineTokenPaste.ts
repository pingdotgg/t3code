import { parseThreadDeepLink } from "@t3tools/shared/threadDeepLinks";
import { ComposerContextId } from "@t3tools/contracts";
import type { ComposerContextClipboardFragment } from "@t3tools/contracts";
import {
  normalizeThreadClipboard,
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const rawText = clipboardData.getData("text/plain");
  const decoded =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  const { text: pastedText, fragment: decodedFragment } = normalizeThreadClipboard(
    rawText,
    decoded,
  );
  if (decodedFragment === null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(pastedText).map((occurrence) => occurrence.contextId),
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

export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  const rawText = clipboardData.getData("text/plain");
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
  const pastedText = rewrittenIds
    ? normalizeThreadClipboard(rawText, fragment, rewrittenIds).text
    : rawText;
  const text =
    rewrittenIds && rewrittenIds.size > 0
      ? replaceComposerContextReferences(pastedText, (occurrence) => {
          const nextId = rewrittenIds.get(occurrence.contextId);
          return nextId
            ? formatComposerContextReference({
                ...occurrence,
                contextId: ComposerContextId.make(nextId),
                kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
              })
            : occurrence.source;
        })
      : pastedText;
  return text;
}

export function isComposerContextPaste(clipboardData: Pick<DataTransfer, "getData">): boolean {
  if (
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ||
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"))
  )
    return true;
  const text = clipboardData.getData("text/plain").trim();
  return text.length > 0 && text.split(/\s+/).every((value) => parseThreadDeepLink(value) !== null);
}
