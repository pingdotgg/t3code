import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Codex web search cites sources as U+E200 "cite" (U+E202 source id)+ U+E201. The ids resolve
// against search results T3 Code never receives, so a marker can only be hidden, not linked.
export const CODEX_WEB_CITATION_START = "cite";
const CITATION = /cite[^]*/gu;
const ENDS_PHRASE = /[\s.,;:!?)\]}]/u;
const DELIMITED = new Set(["emphasis", "strong", "delete"]);
const DELIMITER = /[*_~]/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WORD_JOINER = "\u2060";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface SourceRewrite {
  readonly source: string;
  readonly edits: SourceEdit[];
}

/**
 * `first` and `last` say whether the text opens or closes its parent. Space left against that
 * edge would sit inside an emphasis delimiter and stop it from parsing, so it goes too.
 */
function withoutCitations(text: string, first: boolean, last: boolean): string {
  let kept = "";
  let cursor = 0;
  for (const match of text.matchAll(CITATION)) {
    kept += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const next = text[cursor];
    // With nothing after it in this node, the space separates the text from the next sibling.
    if (next === undefined ? last : ENDS_PHRASE.test(next)) kept = kept.replace(/[ \t]+$/u, "");
    if (kept.endsWith("\n") || (first && kept === "")) {
      while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    }
  }
  return kept + text.slice(cursor);
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && !/\s/u.test(character) && !PUNCTUATION.test(character);
}

/**
 * A delimiter with punctuation inside it and a word character outside is literal text. A marker
 * at that edge was what kept the delimiter working, so an invisible word joiner takes its place.
 */
function keepingDelimiters(
  shown: string,
  text: string,
  range: SourceRange,
  parent: SourceRange,
  source: string,
  first: boolean,
  last: boolean,
): string {
  let kept = shown;
  if (last && text.endsWith("\uE201")) {
    let outside = parent.end;
    while (DELIMITER.test(source[outside] ?? "")) outside += 1;
    const inside = shown.at(-1) ?? source[range.start - 1] ?? "";
    if (PUNCTUATION.test(inside) && isWordCharacter(source[outside])) kept += WORD_JOINER;
  }
  if (first && text.startsWith(CODEX_WEB_CITATION_START)) {
    let outside = parent.start - 1;
    while (DELIMITER.test(source[outside] ?? "")) outside -= 1;
    const inside = shown[0] ?? source[range.end] ?? "";
    if (PUNCTUATION.test(inside) && isWordCharacter(source[outside])) kept = WORD_JOINER + kept;
  }
  return kept;
}

function sourceRange(node: MarkdownNode): SourceRange | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end };
}

// Only text nodes are edited, so a marker written in code stays literal. With `rewrite`, text is
// read from the source instead of the node, whose value has escapes and references resolved.
function hideCitations(parent: MarkdownNode, rewrite?: SourceRewrite): void {
  const children = parent.children ?? [];
  const parentRange = DELIMITED.has(parent.type) ? sourceRange(parent) : undefined;
  parent.children = children.filter((child, index) => {
    const range = sourceRange(child);

    if (child.type === "text") {
      const text = rewrite
        ? range
          ? rewrite.source.slice(range.start, range.end)
          : ""
        : child.value;
      if (!text?.includes(CODEX_WEB_CITATION_START)) return true;
      const first = index === 0;
      const last = index === children.length - 1;
      const shown = withoutCitations(text, first, last);
      child.value = shown;
      if (rewrite && range) {
        rewrite.edits.push({
          ...range,
          text: parentRange
            ? keepingDelimiters(shown, text, range, parentRange, rewrite.source, first, last)
            : shown,
        });
      }
      return shown !== "";
    }

    // A bare URL takes a marker that directly follows it into the autolink.
    if (child.type === "link" && child.url?.includes(CODEX_WEB_CITATION_START)) {
      child.url = child.url.replace(CITATION, "");
    }
    if (!child.children) return true;

    const editsBefore = rewrite?.edits.length ?? 0;
    hideCitations(child, rewrite);
    if (child.children.length > 0 || !DELIMITED.has(child.type)) return true;
    // Empty delimiters would show as literal asterisks.
    if (rewrite && range) {
      rewrite.edits.length = editsBefore;
      rewrite.edits.push({ ...range, text: "" });
    }
    return false;
  });
}

/** Add only where an assistant message renders: a user may have typed a marker on purpose. */
export function remarkHideCodexWebCitations() {
  return (tree: unknown) => {
    hideCitations(tree as MarkdownNode);
  };
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

/** Assistant Markdown without web-search citation markers, for copying and native display. */
export function hideCodexWebCitations(markdown: string): string {
  if (!markdown.includes(CODEX_WEB_CITATION_START)) return markdown;

  const rewrite: SourceRewrite = { source: markdown, edits: [] };
  hideCitations(markdownParser.parse(markdown) as MarkdownNode, rewrite);
  let shown = "";
  let cursor = 0;
  for (const edit of rewrite.edits) {
    shown += markdown.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return shown + markdown.slice(cursor);
}
