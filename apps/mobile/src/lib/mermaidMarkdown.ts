import type { Definition, Nodes } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";

const parser = unified().use(remarkParse);

export type MermaidMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | {
      readonly kind: "mermaid";
      readonly source: string;
      readonly markdown: string;
      readonly sourceOffset: number;
    };

const CLOSING_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// Info strings decode character references, so `&` may still spell "mermaid".
const MERMAID_FENCE_PATTERN = /^\uFEFF? {0,3}(?:`{3,}|~{3,})[ \t]*(?:mermaid|&)/im;

function escapeDestination(text: string, special: RegExp): string {
  return text.replace(special, "\\$&").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

// A definition's source may span blockquote lines, so rebuild it as one standalone line.
// `identifier` is the normalized raw label (`label` is decoded), so it re-parses to itself.
function standaloneDefinition(node: Definition): string {
  const url = escapeDestination(node.url, /[\\<>&]/g);
  const title = node.title == null ? "" : ` "${escapeDestination(node.title, /[\\"&]/g)}"`;
  return `[${node.identifier}]: <${url}>${title}`;
}

/**
 * Splits closed, unindented mermaid fences out of markdown. Unclosed fences stay
 * markdown so a streaming diagram shows as code until its closing fence arrives.
 */
export function splitMermaidMarkdown(markdown: string): ReadonlyArray<MermaidMarkdownSegment> {
  if (!MERMAID_FENCE_PATTERN.test(markdown)) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }

  const document = parser.parse(markdown);
  // remark drops a leading byte order mark, so its offsets start one character later.
  const shift = markdown.startsWith("\uFEFF") ? 1 : 0;
  const offset = (node: Nodes, edge: "start" | "end") => {
    const value = node.position?.[edge].offset;
    return value === undefined ? undefined : value + shift;
  };
  const segments: MermaidMarkdownSegment[] = [];
  let cursor = shift;
  for (const node of document.children) {
    if (node.type !== "code" || node.lang?.toLowerCase() !== "mermaid") continue;
    const start = offset(node, "start");
    const end = offset(node, "end");
    if (start === undefined || end === undefined) continue;
    if (start > shift && markdown[start - 1] !== "\n") continue;
    const block = markdown.slice(start, end);
    const bodyStart = block.indexOf("\n") + 1;
    const closeStart = block.lastIndexOf("\n") + 1;
    // An unclosed fence runs to the end of the document, so its last line is not a valid close.
    const close = CLOSING_FENCE_PATTERN.exec(block.slice(closeStart))?.[1];
    const opener = /^(?:`{3,}|~{3,})/.exec(block)?.[0];
    if (!close || !opener || bodyStart === 0) continue;
    if (close[0] !== opener[0] || close.length < opener.length) continue;
    const source = block.slice(bodyStart, closeStart);
    if (source.trim().length === 0) continue;
    if (start > cursor) {
      segments.push({
        kind: "markdown",
        markdown: markdown.slice(cursor, start),
        sourceOffset: cursor,
      });
    }
    segments.push({ kind: "mermaid", source, markdown: block, sourceOffset: start });
    cursor = markdown.startsWith("\r\n", end) ? end + 2 : markdown[end] === "\n" ? end + 1 : end;
  }
  if (segments.length === 0) return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  if (cursor < markdown.length) {
    segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  }
  const definitions = new Map<string, Definition>();
  const references: { offset: number; identifier: string }[] = [];
  const pending: Nodes[] = [document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    const start = offset(node, "start");
    if (node.type === "definition") {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
    } else if (
      (node.type === "linkReference" || node.type === "imageReference") &&
      start !== undefined
    ) {
      references.push({ offset: start, identifier: node.identifier });
    }
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        const child = node.children[index];
        if (child) pending.push(child);
      }
    }
  }
  if (references.length === 0) return segments;
  let referenceIndex = 0;
  // Native views parse independently, so carry each fragment's reference definitions with it.
  return segments.map((segment) => {
    const needed = new Set<string>();
    const end = segment.sourceOffset + segment.markdown.length;
    while (referenceIndex < references.length) {
      const reference = references[referenceIndex];
      if (!reference || reference.offset >= end) break;
      if (reference.offset >= segment.sourceOffset) needed.add(reference.identifier);
      referenceIndex++;
    }
    const prefix = [...needed]
      .flatMap((identifier) => {
        const definition = definitions.get(identifier);
        return definition ? [standaloneDefinition(definition)] : [];
      })
      .join("\n");
    return prefix ? { ...segment, markdown: `${prefix}\n\n${segment.markdown}` } : segment;
  });
}
