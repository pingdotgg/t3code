/** Split ```mermaid fences out so mobile renders diagrams, not code text. */

export type MermaidMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly key: string }
  | {
      readonly kind: "mermaid";
      readonly source: string;
      readonly id: string;
      readonly key: string;
    };

const FENCE_RE = /^ {0,3}(```|~~~)[ \t]*([^\n]*)\n?/;

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

export function splitMarkdownWithMermaid(markdown: string): MermaidMarkdownSegment[] {
  const segments: MermaidMarkdownSegment[] = [];
  const lines = markdown.split("\n");
  let markdownStart = 0;
  let index = 0;

  const pushMarkdown = (end: number) => {
    if (end > markdownStart) {
      const markdown = lines.slice(markdownStart, end).join("\n");
      segments.push({
        kind: "markdown",
        markdown,
        key: `md-${markdownStart}-${fenceHash(markdown)}`,
      });
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const open = FENCE_RE.exec(line);
    if (!open || fenceLanguage(open[2] ?? "") !== "mermaid") {
      index += 1;
      continue;
    }
    const fence = open[1] ?? "```";
    const closeRe = new RegExp(`^ {0,3}${fence === "```" ? "```" : "~~~"}[ \\t]*$`);
    let close = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      if (closeRe.test(lines[scan] ?? "")) {
        close = scan;
        break;
      }
    }
    // Unclosed fence: leave it as Markdown (streaming or authored that way).
    if (close === -1) {
      index += 1;
      continue;
    }
    pushMarkdown(index);
    const source = lines.slice(index + 1, close).join("\n");
    segments.push({
      kind: "mermaid",
      source,
      id: fenceHash(source),
      key: `mmd-${index}-${fenceHash(source)}`,
    });
    index = close + 1;
    markdownStart = index;
  }
  pushMarkdown(lines.length);
  return segments.filter((segment) => segment.kind === "mermaid" || segment.markdown.length > 0);
}
