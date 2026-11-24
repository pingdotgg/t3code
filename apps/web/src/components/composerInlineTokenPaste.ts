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

// Matches ProseMirror's default clipboard parser, which a custom handlePaste bypasses.
export function readPastedPlainText(clipboardData: Pick<DataTransfer, "getData">): string {
  return clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlText(html: string): string {
  return html.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (entity, name: string) => {
    if (name[0] !== "#") return HTML_ENTITIES[name.toLowerCase()] ?? entity;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

const htmlTextContent = (html: string) =>
  decodeHtmlText(html.replace(/<[^<>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + search.length)) {
    count += 1;
  }
  return count;
}

/**
 * Rich text keeps a hyperlink's destination only in text/html, so each http(s) anchor whose text
 * is found in the plain text becomes a Markdown link there. A destination the plain text already
 * shows (a bare URL, or Markdown copied from T3 itself) is left alone.
 */
function addPastedHtmlLinks(plainText: string, html: string): string {
  if (!html) return plainText;
  const anchorStart = /<a[\s>]/gi;
  const anchorEnd = /<\/a\s*>/gi;
  let result = "";
  let plainCursor = 0;
  let htmlCursor = 0;
  for (let open = anchorStart.exec(html); open; open = anchorStart.exec(html)) {
    const tagEnd = html.indexOf(">", open.index);
    if (tagEnd === -1) break;
    anchorEnd.lastIndex = tagEnd;
    const close = anchorEnd.exec(html);
    if (!close) break;
    anchorStart.lastIndex = anchorEnd.lastIndex;
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
      html.slice(open.index, tagEnd),
    );
    const url = decodeHtmlText((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    const label = htmlTextContent(html.slice(tagEnd + 1, close.index));
    if (!/^https?:\/\/\S+$/i.test(url) || !label || plainText.includes(url)) continue;
    // Skip the label's occurrences in the text before this anchor, so the right one is linked.
    const textBefore = htmlTextContent(html.slice(htmlCursor, open.index));
    htmlCursor = anchorEnd.lastIndex;
    let at = plainText.indexOf(label, plainCursor);
    for (let skip = countOccurrences(textBefore, label); skip > 0 && at !== -1; skip -= 1) {
      at = plainText.indexOf(label, at + label.length);
    }
    if (at === -1) continue;
    const markdownLabel = label.replace(/[\\[\]]/g, "\\$&");
    const markdownUrl = url.replace(/[()<>]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
    result += `${plainText.slice(plainCursor, at)}[${markdownLabel}](${markdownUrl})`;
    plainCursor = at + label.length;
  }
  return result + plainText.slice(plainCursor);
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
  const pastedText = addPastedHtmlLinks(
    readPastedPlainText(clipboardData),
    clipboardData.getData("text/html"),
  );
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
