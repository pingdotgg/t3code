import type { IweLink, IweNoteSummary } from "@t3tools/contracts";

/** Turns a link in a note into the key it points at, or null for web links and anchors. */
export function resolveNoteLink(currentKey: string, href: string): string | null {
  const trimmed = decodeURIComponent(href.trim());
  if (trimmed === "" || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed))
    return null;
  const withoutFragment = trimmed.split("#")[0]!.split("?")[0]!.replace(/\.md$/i, "");
  const base = withoutFragment.startsWith("/") ? [] : currentKey.split("/").slice(0, -1);
  const parts = [...base];
  for (const segment of withoutFragment.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** Wiki links become ordinary links the preview can follow; IWE resolves `[[key]]` from the root. */
export function wikiLinksToMarkdown(text: string): string {
  return text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, key: string, title?: string) => `[${(title ?? key).trim()}](/${key.trim()})`,
  );
}

/** Inline references and inclusion parents, without duplicates, in the order IWE gives them. */
export function backlinksOf(note: Pick<IweNoteSummary, "referencedBy" | "includedBy">): IweLink[] {
  const seen = new Set<string>();
  return [...note.includedBy, ...note.referencedBy].filter((link) =>
    seen.has(link.key) ? false : (seen.add(link.key), true),
  );
}

export function outgoingLinksOf(note: Pick<IweNoteSummary, "references" | "includes">): IweLink[] {
  const seen = new Set<string>();
  return [...note.includes, ...note.references].filter((link) =>
    seen.has(link.key) ? false : (seen.add(link.key), true),
  );
}

/** Line and UTF-16 column of an offset, as the language server counts them. */
export function positionAt(
  text: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

/** True while the cursor is inside an unfinished `[...` link label, where IWE completes links. */
export function wantsLinkCompletion(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  const open = line.lastIndexOf("[");
  return open !== -1 && !line.slice(open).includes("]");
}

/** Replaces columns `from`..`to` of the cursor's line with `insert`; returns text and new cursor. */
export function applyCompletion(
  text: string,
  offset: number,
  from: number,
  to: number,
  insert: string,
) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const start = lineStart + from;
  const end = lineStart + Math.max(to, offset - lineStart);
  return { text: text.slice(0, start) + insert + text.slice(end), cursor: start + insert.length };
}
