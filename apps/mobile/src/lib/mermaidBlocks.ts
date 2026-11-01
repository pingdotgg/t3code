/** Split ```mermaid fences out so mobile renders diagrams, not code text. */

export type MermaidMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly key: string }
  | {
      readonly kind: "mermaid";
      readonly source: string;
      readonly id: string;
      readonly key: string;
    };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)\n?/;
const QUOTE_RE = /^(?: {0,3}>[ \t]?)+/;
const DEFINITION_RE = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/;

function stripQuote(line: string): string {
  return line.replace(QUOTE_RE, "");
}

function quoteDepth(line: string): number {
  const match = QUOTE_RE.exec(line);
  if (!match) return 0;
  return match[0].split(">").length - 1;
}

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function fenceHash(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return `m${(hash >>> 0).toString(36)}`;
}

function closerIndex(
  lines: readonly string[],
  depths: readonly number[],
  from: number,
  fence: string,
  minDepth: number,
): number {
  const char = fence[0] === "`" ? "`" : "~";
  const closeRe = new RegExp(`^ {0,3}${char}{${fence.length},}[ \\t]*$`);
  for (let scan = from; scan < lines.length; scan += 1) {
    // A fenced block ends when its blockquote ends, so only a fence at the
    // opener's quote depth or deeper can close it.
    if ((depths[scan] ?? 0) >= minDepth && closeRe.test(lines[scan] ?? "")) return scan;
  }
  return -1;
}

/** Reference definitions on lines outside any fenced block. */
function collectDefinitions(markdown: string): string[] {
  const found: string[] = [];
  const lines = markdown.split("\n").map(stripQuote);
  const depths = markdown.split("\n").map(quoteDepth);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const open = FENCE_RE.exec(line);
    if (open) {
      const depth = depths[index] ?? 0;
      const close = closerIndex(lines, depths, index + 1, open[1] ?? "```", depth);
      if (close === -1) {
        if (depth === 0) {
          index = lines.length;
        } else {
          // The fence ends where its blockquote ends; resume after it.
          let resume = index + 1;
          while (resume < lines.length && (depths[resume] ?? 0) >= depth) resume += 1;
          index = resume;
        }
        continue;
      }
      index = close + 1;
      continue;
    }
    if (DEFINITION_RE.test(line)) found.push(line);
    index += 1;
  }
  return [...new Set(found)];
}

export function splitMarkdownWithMermaid(markdown: string): MermaidMarkdownSegment[] {
  const raw: Array<
    | { readonly kind: "markdown"; readonly markdown: string; readonly start: number }
    | {
        readonly kind: "mermaid";
        readonly source: string;
        readonly id: string;
        readonly start: number;
      }
  > = [];
  const lines = markdown.split("\n");
  const text = lines.map(stripQuote);
  const depths = lines.map(quoteDepth);
  let markdownStart = 0;
  let index = 0;

  const pushMarkdown = (end: number) => {
    if (end > markdownStart) {
      raw.push({
        kind: "markdown",
        markdown: lines.slice(markdownStart, end).join("\n"),
        start: markdownStart,
      });
    }
  };

  while (index < lines.length) {
    const open = FENCE_RE.exec(text[index] ?? "");
    if (!open) {
      index += 1;
      continue;
    }
    const fence = open[1] ?? "```";
    const depth = depths[index] ?? 0;
    const close = closerIndex(text, depths, index + 1, fence, depth);
    if (close === -1) {
      index += 1;
      continue;
    }
    // A non-mermaid fence may document a mermaid example; keep it whole.
    if (fenceLanguage(open[2] ?? "") !== "mermaid") {
      index = close + 1;
      continue;
    }
    pushMarkdown(index);
    const source = text.slice(index + 1, close).join("\n");
    raw.push({ kind: "mermaid", source, id: fenceHash(source), start: index });
    index = close + 1;
    markdownStart = index;
  }
  pushMarkdown(lines.length);

  // Link reference definitions resolve per parser instance, so share them
  // with every Markdown segment instead of stranding uses after a fence.
  const definitions = [
    ...new Set(
      raw.flatMap((segment) =>
        segment.kind === "markdown" ? collectDefinitions(segment.markdown) : [],
      ),
    ),
  ];
  const prefix = definitions.length > 0 ? `${definitions.join("\n")}\n` : "";

  return raw
    .map((segment): MermaidMarkdownSegment => {
      if (segment.kind === "mermaid") {
        return {
          kind: "mermaid",
          source: segment.source,
          id: segment.id,
          key: `mmd-${segment.start}`,
        };
      }
      const segmentDefinitions = collectDefinitions(segment.markdown);
      const needsPrefix =
        prefix.length > 0 &&
        !definitions.every((definition) => segmentDefinitions.includes(definition));
      const text = needsPrefix ? `${prefix}${segment.markdown}` : segment.markdown;
      return { kind: "markdown", markdown: text, key: `md-${segment.start}` };
    })
    .filter((segment) => segment.kind === "mermaid" || segment.markdown.length > 0);
}
