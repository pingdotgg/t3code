const indentAfter = (prefix: string, rest: string) => {
  let c = 0;
  for (const ch of prefix) c += ch === "\t" ? 4 - (c % 4) : 1;
  const start = c + (prefix.endsWith(">") && rest.startsWith("\t") ? 1 : 0);
  for (const ch of rest) c += ch === "\t" ? 4 - (c % 4) : 1;
  return c - start;
};

/** Offset of the `[ ]` marker at the start of the list item beginning at `listItemStart`. */
export function taskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  if (listItemStart < 0 || listItemStart >= markdown.length) return null;
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (match?.[1]) return listItemStart + firstLine.indexOf(match[1]);

  const marker = firstLineEnd === -1 ? null : firstLine.match(/^([ \t]*)([-+*]|\d+[.)])[ \t]*\r?$/);
  if (!marker?.[2]) return null;
  const lineStart = listItemStart > 0 ? markdown.lastIndexOf("\n", listItemStart - 1) + 1 : 0;
  const before = markdown.slice(lineStart, listItemStart + (marker[1]?.length ?? 0));
  const [, quote = "", lead = ""] = before.match(/^((?:.*> ?)?)(.*)$/) ?? [];
  const required = indentAfter(quote, lead) + marker[2].length + 1;
  const nextStart = firstLineEnd + 1;
  const nextEnd = markdown.indexOf("\n", nextStart);
  const nextLine = markdown.slice(nextStart, nextEnd === -1 ? markdown.length : nextEnd);
  const quotes = before.split(">").length - 1;
  const pattern = new RegExp(`^((?:[ \\t]*> ?){${quotes}})([ \\t]*)\\[[ xX]\\](?=[ \\t\\r]|$)`);
  const cont = nextLine.match(pattern);
  if (!cont) return null;
  const [, q = "", ws = ""] = cont;
  const indent = indentAfter(q, ws);
  return indent >= required && indent < required + 4 ? nextStart + q.length + ws.length : null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
