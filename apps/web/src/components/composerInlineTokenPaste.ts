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
export function readPastedComposerText(clipboardData: Pick<DataTransfer, "getData">): string {
  return clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
}

export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  if (decodedFragment === null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(clipboardData.getData("text/plain")).map(
      (occurrence) => occurrence.contextId,
    ),
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
  pastedText = readPastedComposerText(clipboardData),
): string {
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
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
