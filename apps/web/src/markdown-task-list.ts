function lineIndexAtOffset(source: string, offset: number): number {
  let line = 0;
  const limit = Math.min(Math.max(offset, 0), source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function lineStartOffset(source: string, lineIndex: number): number {
  if (lineIndex <= 0) return 0;
  let line = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      if (line === lineIndex) return i + 1;
    }
  }
  return source.length;
}

function taskListMarkerStart(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

/**
 * Task clicks mutate `markdown` (the raw message/file). `listItemStart` comes
 * from the parsed tree, which may be a rewritten source whose earlier offsets
 * no longer match.
 */
export function findTaskListMarkerOffset(
  markdown: string,
  listItemStart: number,
  parsedMarkdown: string = markdown,
): number | null {
  if (
    parsedMarkdown === markdown ||
    (listItemStart <= markdown.length &&
      markdown.startsWith(parsedMarkdown.slice(0, listItemStart)))
  ) {
    return taskListMarkerStart(markdown, listItemStart);
  }

  return taskListMarkerStart(
    markdown,
    lineStartOffset(markdown, lineIndexAtOffset(parsedMarkdown, listItemStart)),
  );
}
