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

const plainTextPastes = new WeakSet<object>();

/** Paste as Text keeps the clipboard's plain text, so it skips titled link recovery. */
export function markPlainTextPaste(clipboardData: object): void {
  plainTextPastes.add(clipboardData);
}

export function readPastedComposerLink(
  clipboardData: Pick<DataTransfer, "getData">,
): string | null {
  if (plainTextPastes.has(clipboardData)) return null;
  const pastedText = clipboardData.getData("text/plain");
  const text = pastedText.trim();
  if (!text || /^[a-z][a-z\d+.-]*:\S+$/i.test(text)) return null;
  if (clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) return null;
  const html = clipboardData.getData("text/html");
  if (!html || !/<a[\s>]/i.test(html)) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  if (document.querySelector("[data-t3-context-fragment]")) return null;
  const links = document.querySelectorAll("a[href]");
  if (links.length !== 1) return null;
  const link = links[0]!;
  const label = link.textContent?.trim();
  if (label !== text || document.body.textContent?.trim() !== text) return null;
  const href = link.getAttribute("href")?.trim();
  if (!href || !/^https?:\/\/\S+$/i.test(href) || !URL.canParse(href)) return null;
  return pastedText.replace(text, () => href);
}

/** Pasted thread links count as context too, so they become chips like a copied chip does. */
export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const pastedText = clipboardData.getData("text/plain");
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
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

export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  const pastedLink = readPastedComposerLink(clipboardData);
  if (pastedLink) return pastedLink;
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
