function delimiterRunLength(markdown: string, start: number, delimiter: string): number {
  let end = start;
  while (markdown[end] === delimiter) end += 1;
  return end - start;
}

function isFenceStart(markdown: string, index: number): boolean {
  const lineStart = markdown.lastIndexOf("\n", index - 1) + 1;
  const prefix = markdown.slice(lineStart, index);
  return prefix.length <= 3 && /^ *$/.test(prefix);
}

function fenceEnd(markdown: string, start: number, delimiter: string, runLength: number): number {
  let lineStart = markdown.indexOf("\n", start) + 1;
  if (lineStart === 0) return markdown.length;
  while (lineStart < markdown.length) {
    let cursor = lineStart;
    let spaces = 0;
    while (markdown[cursor] === " " && spaces < 4) {
      cursor += 1;
      spaces += 1;
    }
    if (
      spaces <= 3 &&
      markdown[cursor] === delimiter &&
      delimiterRunLength(markdown, cursor, delimiter) >= runLength
    ) {
      const lineEnd = markdown.indexOf("\n", cursor);
      const closingRunLength = delimiterRunLength(markdown, cursor, delimiter);
      const suffix = markdown.slice(
        cursor + closingRunLength,
        lineEnd < 0 ? markdown.length : lineEnd,
      );
      if (/^[ \t]*$/.test(suffix)) {
        return lineEnd < 0 ? markdown.length : lineEnd + 1;
      }
    }
    const nextLine = markdown.indexOf("\n", lineStart);
    if (nextLine < 0) return markdown.length;
    lineStart = nextLine + 1;
  }
  return markdown.length;
}

function balancedEnd(markdown: string, start: number, opening: string, closing: string): number {
  let depth = 1;
  for (let cursor = start; cursor < markdown.length; cursor += 1) {
    const character = markdown[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

export function markdownLinkDestinations(markdown: string): ReadonlyArray<string> {
  const destinations: Array<string> = [];
  let cursor = 0;
  let paragraphActive = false;
  while (cursor < markdown.length) {
    if (cursor === 0 || markdown[cursor - 1] === "\n") {
      const lineEnd = markdown.indexOf("\n", cursor);
      const line = markdown.slice(cursor, lineEnd < 0 ? markdown.length : lineEnd);
      if (/^[ \t]*$/.test(line)) {
        paragraphActive = false;
        cursor = lineEnd < 0 ? markdown.length : lineEnd + 1;
        continue;
      }
      if (!paragraphActive && (markdown[cursor] === "\t" || markdown.startsWith("    ", cursor))) {
        cursor = lineEnd < 0 ? markdown.length : lineEnd + 1;
        continue;
      }
      paragraphActive = true;
    }
    const character = markdown[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "`" || character === "~") {
      const runLength = delimiterRunLength(markdown, cursor, character);
      if (runLength >= 3 && isFenceStart(markdown, cursor)) {
        paragraphActive = false;
        cursor = fenceEnd(markdown, cursor, character, runLength);
        continue;
      }
      if (character === "`") {
        const delimiter = "`".repeat(runLength);
        const end = markdown.indexOf(delimiter, cursor + runLength);
        cursor = end < 0 ? cursor + runLength : end + runLength;
        continue;
      }
    }
    if (character !== "[") {
      cursor += 1;
      continue;
    }
    const labelEnd = balancedEnd(markdown, cursor + 1, "[", "]");
    if (labelEnd < 0 || markdown[labelEnd + 1] !== "(") {
      cursor += 1;
      continue;
    }
    const destinationStart = labelEnd + 2;
    const destinationEnd = balancedEnd(markdown, destinationStart, "(", ")");
    if (destinationEnd < 0 || destinationEnd === destinationStart) {
      cursor = destinationStart;
      continue;
    }
    destinations.push(markdown.slice(destinationStart, destinationEnd));
    cursor = destinationEnd + 1;
  }
  return destinations;
}
