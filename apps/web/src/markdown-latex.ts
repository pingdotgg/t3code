const LATEX_DELIMITERS = ["\\(", "\\)", "\\[", "\\]"] as const;

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function startingFence(line: string): { marker: "`" | "~"; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const run = match?.[1];
  if (!run) return null;
  return { marker: run[0] as "`" | "~", length: run.length };
}

function closesFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  const run = match?.[1];
  return Boolean(run && run[0] === fence.marker && run.length >= fence.length);
}

/** Converts TeX delimiters before Markdown consumes their leading backslashes. */
export function normalizeLatexDelimiters(markdown: string): string {
  if (!LATEX_DELIMITERS.some((delimiter) => markdown.includes(delimiter))) return markdown;

  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineCodeTicks = 0;

  return markdown
    .split(/(\r?\n)/)
    .map((line) => {
      if (line === "\n" || line === "\r\n") return line;

      if (fence) {
        if (closesFence(line, fence)) fence = null;
        return line;
      }

      if (inlineCodeTicks === 0) {
        const openingFence = startingFence(line);
        if (openingFence) {
          fence = openingFence;
          return line;
        }
        if (/^(?: {4}|\t)/.test(line)) return line;
      }

      let normalized = "";
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];

        if (character === "`" && !isEscaped(line, index)) {
          let runLength = 1;
          while (line[index + runLength] === "`") runLength += 1;
          if (inlineCodeTicks === 0) inlineCodeTicks = runLength;
          else if (inlineCodeTicks === runLength) inlineCodeTicks = 0;
          normalized += "`".repeat(runLength);
          index += runLength - 1;
          continue;
        }

        if (inlineCodeTicks === 0 && character === "\\" && !isEscaped(line, index)) {
          const delimiter = line[index + 1];
          if (delimiter === "(" || delimiter === ")" || delimiter === "[" || delimiter === "]") {
            normalized += "$$";
            index += 1;
            continue;
          }
        }

        normalized += character;
      }
      return normalized;
    })
    .join("");
}
