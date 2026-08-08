/**
 * Rewrite LaTeX `\( ... \)` and `\[ ... \]` delimiters into the `$` / `$$`
 * delimiters that `remark-math` understands.
 *
 * CommonMark treats `\(` as an escape for a literal `(`, so by the time the
 * markdown has been parsed the delimiters are gone and no remark plugin can
 * recover them. The rewrite therefore has to happen on the raw source.
 *
 * Every substitution is length preserving (`\(` -> `$ `, `\)` -> ` $`,
 * `\[` -> `$$`, `\]` -> `$$`) so mdast positions still map back onto the
 * original markdown for consumers that edit the source by offset (task-list
 * checkbox toggling in `ChatMarkdown`). `remark-math` strips one padding
 * space from each side of an inline span, so `$ x $` renders the same as
 * `$x$`.
 *
 * Code spans and fenced code blocks are skipped so literal LaTeX inside a
 * code sample keeps rendering verbatim.
 */
export function normalizeLatexMathDelimiters(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[")) return source;

  const out = source.split("");
  const length = source.length;
  let index = 0;
  let atLineStart = true;

  const replace = (start: number, text: string) => {
    for (let offset = 0; offset < text.length; offset += 1) {
      out[start + offset] = text[offset]!;
    }
  };

  while (index < length) {
    const char = source[index];

    if (char === "\n") {
      atLineStart = true;
      index += 1;
      continue;
    }

    if (atLineStart) {
      const fence = matchFenceOpening(source, index);
      if (fence) {
        index = skipFencedBlock(source, fence);
        continue;
      }
      if (char !== " " && char !== "\t") atLineStart = false;
    }

    if (char === "`") {
      index = skipInlineCode(source, index);
      continue;
    }

    if (char === "\\") {
      const next = source[index + 1];
      if (next === "(") {
        replace(index, "$ ");
      } else if (next === ")") {
        replace(index, " $");
      } else if (next === "[" || next === "]") {
        replace(index, "$$");
      }
      // Every other escape consumes the escaped character verbatim.
      index += 2;
      continue;
    }

    index += 1;
  }

  return out.join("");
}

interface FenceOpening {
  readonly marker: string;
  readonly run: number;
  readonly contentStart: number;
}

function matchFenceOpening(source: string, index: number): FenceOpening | null {
  let cursor = index;
  let indent = 0;
  while (indent < 4 && (source[cursor] === " " || source[cursor] === "\t")) {
    cursor += 1;
    indent += 1;
  }
  const marker = source[cursor];
  if (marker !== "`" && marker !== "~") return null;
  let run = 0;
  while (source[cursor + run] === marker) run += 1;
  if (run < 3) return null;
  return { marker, run, contentStart: cursor + run };
}

function skipFencedBlock(source: string, fence: FenceOpening): number {
  let cursor = source.indexOf("\n", fence.contentStart);
  if (cursor === -1) return source.length;
  cursor += 1;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const line = source.slice(cursor, lineEnd === -1 ? source.length : lineEnd);
    const closing = matchFenceOpening(line, 0);
    if (closing && closing.marker === fence.marker && closing.run >= fence.run) {
      return lineEnd === -1 ? source.length : lineEnd;
    }
    if (lineEnd === -1) return source.length;
    cursor = lineEnd + 1;
  }
  return source.length;
}

function skipInlineCode(source: string, index: number): number {
  let run = 0;
  while (source[index + run] === "`") run += 1;
  const fence = "`".repeat(run);
  const closing = source.indexOf(fence, index + run);
  if (closing === -1) return index + run;
  let after = closing + run;
  while (source[after] === "`") after += 1;
  return after;
}
