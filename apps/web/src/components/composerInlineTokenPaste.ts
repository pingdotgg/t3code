import { ComposerContextId } from "@t3tools/contracts";
import type {
  ComposerContextClipboardFragment,
  ComposerContextRecord,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  threadLinkContextReferences,
} from "@t3tools/shared/composerContextReferences";

import { readThreadShell } from "~/state/entities";

const threadTitle = (ref: ScopedThreadRef) => readThreadShell(ref)?.title;

const readCopiedComposerContext = (clipboardData: Pick<DataTransfer, "getData">) =>
  decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
  decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));

/** Pasted thread links count as context too, so they become chips like a copied chip does. */
function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
  decodedFragment = readCopiedComposerContext(clipboardData),
): ComposerContextClipboardFragment | null {
  const pastedText = clipboardData.getData("text/plain");
  const threads = threadLinkContextReferences(
    pastedText,
    decodedFragment?.records ?? [],
    threadTitle,
  );
  const source =
    decodedFragment?.source ??
    (threads.records[0] ? { environmentId: threads.records[0].environmentId } : null);
  if (source === null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(threads.text).map((occurrence) => occurrence.contextId),
  );
  const records = new Map<string, ComposerContextRecord>();
  for (const record of [...(decodedFragment?.records ?? []), ...threads.records]) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
    records.set(record.contextId, record);
  }
  return {
    version: 1,
    source,
    records: [...records.values()].filter((record) => pastedIds.has(record.contextId)),
  };
}

/** Whether the paste references context copied from T3, which folding it into a file would drop. */
export function pastesCopiedComposerContext(clipboardData: Pick<DataTransfer, "getData">): boolean {
  const copied = readCopiedComposerContext(clipboardData);
  if (copied === null) return false;
  const copiedIds = new Set<string>(copied.records.map((record) => record.contextId));
  return (
    readPastedComposerContext(clipboardData, copied)?.records.some((record) =>
      copiedIds.has(record.contextId),
    ) ?? false
  );
}

export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  const pastedText = clipboardData.getData("text/plain");
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
  if (!rewrittenIds || rewrittenIds.size === 0) return pastedText;
  const nextId = (contextId: string) => {
    const id = rewrittenIds.get(contextId);
    return id ? ComposerContextId.make(id) : undefined;
  };
  const text = replaceComposerContextReferences(pastedText, (occurrence) => {
    const contextId = nextId(occurrence.contextId);
    return contextId
      ? formatComposerContextReference({
          ...occurrence,
          contextId,
          kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
        })
      : occurrence.source;
  });
  // A thread the import refused, on a machine this agent cannot read, stays the link it was.
  return threadLinkContextReferences(text, fragment?.records ?? [], threadTitle, (record) =>
    nextId(record.contextId),
  ).text;
}
