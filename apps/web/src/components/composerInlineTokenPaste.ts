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

import { restorePastedMarkdownLinks } from "~/markdown-clipboard";
import { readThreadShell } from "~/state/entities";

const threadTitle = (ref: ScopedThreadRef) => readThreadShell(ref)?.title;

// Matches ProseMirror's default clipboard parser, which a custom handlePaste bypasses. A leading
// BOM is not content, and kept it would stop a first-line fence from opening a code block.
export function readPastedPlainText(clipboardData: Pick<DataTransfer, "getData">): string {
  return clipboardData
    .getData("text/plain")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

export function readPastedComposerClipboard(
  clipboardData: Pick<DataTransfer, "getData">,
  plainTextOnly = false,
) {
  const plain = readPastedPlainText(clipboardData);
  if (plainTextOnly || !plain) return { text: plain, context: null };
  const html = clipboardData.getData("text/html");
  const text = restorePastedMarkdownLinks(plain, html);
  const copied =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(html);
  const threads = threadLinkContextReferences(text, copied?.records ?? [], threadTitle);
  const source =
    copied?.source ??
    (threads.records[0] ? { environmentId: threads.records[0].environmentId } : null);
  if (source === null) return { text, context: null };
  const pastedIds = new Set<string>(
    collectComposerContextReferences(threads.text).map((occurrence) => occurrence.contextId),
  );
  const records = new Map<string, ComposerContextRecord>();
  for (const record of [...(copied?.records ?? []), ...threads.records]) {
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
  const context: ComposerContextClipboardFragment = {
    version: 1,
    source,
    records: [...records.values()].filter((record) => pastedIds.has(record.contextId)),
  };
  return { text, context };
}

export type PastedComposerClipboard = ReturnType<typeof readPastedComposerClipboard>;

export function importPastedComposerText(
  { text: pastedText, context: fragment }: PastedComposerClipboard,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment?.(fragment) : null;
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
