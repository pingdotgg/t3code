// Entire stores a description as a ProseMirror document; its text snapshot drops every line
// break inside a block and all formatting, so it is only the fallback.

interface ProseMirrorMark {
  readonly type?: unknown;
  readonly attrs?: { readonly href?: unknown } | null;
}

interface ProseMirrorNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attrs?: Record<string, unknown> | null;
  readonly marks?: ReadonlyArray<ProseMirrorMark> | null;
  readonly content?: ReadonlyArray<ProseMirrorNode> | null;
}

/** Entire's self-link at the top of a trail body is noise inside the trail itself. */
const TRAIL_LINK =
  /<!--\s*entire-trail-link-start\s*-->[\s\S]*?<!--\s*entire-trail-link-end\s*-->/gu;

const isNode = (value: unknown): value is ProseMirrorNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const children = (node: ProseMirrorNode): ReadonlyArray<ProseMirrorNode> =>
  Array.isArray(node.content) ? node.content.filter(isNode) : [];

const safeHref = (href: unknown): string | null =>
  typeof href === "string" && /^(https?:|mailto:)/iu.test(href) ? href : null;

/** Records what the renderer leaves out; only the first loss is reported. */
type Lose = (what: string) => void;

const MARKS = new Set(["bold", "italic", "strike", "code", "link"]);

const unsupported = (node: ProseMirrorNode) =>
  typeof node.type === "string" ? `unsupported content: ${node.type}` : "unsupported content";

const longestBacktickRun = (text: string) =>
  Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));

/**
 * Typed characters markdown would read as formatting. A delimiter needs a partner, so a lone one
 * stays as typed, as does `_` inside a word; a partner in a neighbouring node is not looked for.
 */
function escapeText(text: string): string {
  const paired = (char: string) => text.split(char).length > 2;
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/gu, "\\\\")
    .replace(/[`*~]/gu, (char) => (paired(char) ? `\\${char}` : char))
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (char) => (paired(char) ? "\\_" : char))
    .replace(/\[(?=[^\]]*\]\()/gu, "\\[");
}

function renderText(node: ProseMirrorNode, lose: Lose): string {
  const raw = typeof node.text === "string" ? node.text : "";
  if (raw === "") return "";
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const has = (type: string) => marks.some((mark) => mark?.type === type);
  if (marks.some((mark) => typeof mark?.type !== "string" || !MARKS.has(mark.type)))
    lose("unsupported text formatting");
  if (has("code")) {
    if (marks.some((mark) => mark?.type !== "code")) lose("formatted or linked code");
    const delimiter = "`".repeat(longestBacktickRun(raw) + 1);
    const pad = raw.startsWith("`") || raw.endsWith("`") ? " " : "";
    return `${delimiter}${pad}${raw}${pad}${delimiter}`;
  }
  let text = escapeText(raw);
  if (has("bold")) text = `**${text}**`;
  // `*`, not `_`: Entire's markdown converter reads only `*` emphasis back.
  if (has("italic")) text = `*${text}*`;
  if (has("strike")) text = `~~${text}~~`;
  const link = marks.find((mark) => mark?.type === "link");
  const href = link ? safeHref(link.attrs?.href) : null;
  if (link && href === null) lose("links that aren't web or mail links");
  return href ? `[${text}](${href})` : text;
}

function renderInline(node: ProseMirrorNode, lose: Lose): string {
  return children(node)
    .map((child) => {
      if (child.type === "text") return renderText(child, lose);
      // A trailing backslash is a hard break Entire's converter keeps; a bare newline joins.
      if (child.type === "hardBreak") return "\\\n";
      lose(unsupported(child));
      return renderInline(child, lose);
    })
    .join("");
}

const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${prefix}${line}`))
    .join("\n");

function renderList(node: ProseMirrorNode, ordered: boolean, lose: Lose): string {
  const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
  return children(node)
    .map((item, index) => {
      if (item.type !== "listItem") lose(unsupported(item));
      const marker = ordered ? `${start + index}.` : "-";
      const body = children(item)
        .map((child) => renderBlock(child, lose))
        .filter(Boolean)
        .join("\n");
      return `${marker} ${indent(body, " ".repeat(marker.length + 1))}`;
    })
    .join("\n");
}

function renderBlock(node: ProseMirrorNode, lose: Lose): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node, lose).replace(
        /^( {0,3})(#{1,6}(?=\s|$)|[>*+-](?=\s|$)|-(?=(?:[ \t]*-){2,}[ \t]*$)|\d{1,9}[.)](?=\s))/gmu,
        (_, indent: string, marker: string) =>
          indent + marker.replace(/[#>*+.)-]/u, (char) => `\\${char}`),
      );
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${renderInline(node, lose)}`;
    }
    case "bulletList":
      return renderList(node, false, lose);
    case "orderedList":
      return renderList(node, true, lose);
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = children(node)
        .map((child) => {
          if (child.type !== "text") lose(unsupported(child));
          return typeof child.text === "string" ? child.text : "";
        })
        .join("");
      const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
      return `${fence}${language}\n${code}\n${fence}`;
    }
    case "blockquote":
      return children(node)
        .map((child) => renderBlock(child, lose))
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "horizontalRule":
      return "---";
    case "doc":
      return renderChildren(node, lose);
    case "text":
      return renderText(node, lose);
    default:
      lose(unsupported(node));
      return children(node).length > 0 ? renderChildren(node, lose) : renderText(node, lose);
  }
}

function renderChildren(node: ProseMirrorNode, lose: Lose): string {
  return children(node)
    .map((child) => renderBlock(child, lose))
    .filter(Boolean)
    .join("\n\n");
}

interface TrailBodyDocument {
  readonly text_snapshot: string;
  readonly content_json?: unknown;
}

function render(document: TrailBodyDocument): { markdown: string; lost: string | null } {
  let lost: string | null = null;
  const lose: Lose = (what) => {
    lost ??= what;
  };
  const doc = document.content_json;
  const rendered = isNode(doc) && doc.type === "doc" ? renderBlock(doc, lose) : "";
  const body = rendered.trim() === "" ? document.text_snapshot : rendered;
  return { markdown: collapseBlankLines(body.replace(TRAIL_LINK, "")).trim(), lost };
}

export function trailBodyMarkdown(document: TrailBodyDocument): string {
  return render(document).markdown;
}

/** What the markdown shown for a description leaves out of Entire's document, or null. */
export function unrenderedContent(document: TrailBodyDocument): string | null {
  return render(document).lost;
}

/** Blank lines inside a code block are its content; elsewhere one separates blocks. */
function collapseBlankLines(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .filter((line, index, lines) => {
      const opened = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (line.trim().startsWith(fence)) fence = null;
        return true;
      }
      if (opened) fence = opened;
      return !(line.trim() === "" && lines[index - 1]?.trim() === "");
    })
    .join("\n");
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/u;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/u;
const QUOTE = /^\s{0,3}>/u;
const BLANK_QUOTE = /^\s{0,3}>\s*$/u;
const LIST_ITEM = /^(\s*)(?:[-*+]|(\d+)[.)])\s+/u;
const UNDERSCORE_EMPHASIS = /(^|[^\w\\])(__?)(?=\S).*?(?<=\S)\2(?!\w)/u;
const STRIKE = /~~(?=\S).*?~~/u;
const ESCAPE = /\\[\\`*_~[\]#>+.)-]/u;
/** `***x***` reads back as bold `*x` and a stray `*`. */
const BOLD_ITALIC = /\*\*\*/u;

/**
 * What Entire's markdown converter would drop on a rewrite, or null. It reads `*` emphasis only,
 * no strikethrough, one line per flat list item, no list start or code language, and one
 * paragraph per quote.
 */
export function unpreservedMarkdown(markdown: string): string | null {
  let fence: string | null = null;
  let previous: "blank" | "paragraph" | "list" | "other" = "blank";
  let ordered = false;
  for (const line of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    if (fence !== null) {
      if (line.trim().startsWith(fence)) {
        fence = null;
        previous = "other";
      } else if (line.trim().startsWith(fence.slice(0, 3))) return "code blocks containing fences";
      continue;
    }
    const opened = FENCE.exec(line);
    if (opened) {
      if (opened[2]?.trim()) return "code block languages";
      fence = opened[1] ?? "```";
      previous = "other";
      continue;
    }
    if (line.trim() === "") {
      previous = "blank";
      ordered = false;
      continue;
    }
    // Entire's converter reads code only between single backticks, and no escapes.
    if (/(?<!\\)``/u.test(line)) return "code containing backticks";
    const prose = line.replace(/(?<!\\)`[^`]*`/gu, "");
    if (ESCAPE.test(prose)) return "escaped markdown characters";
    if (STRIKE.test(prose)) return "strikethrough";
    if (UNDERSCORE_EMPHASIS.test(prose)) return "underscore emphasis";
    if (BOLD_ITALIC.test(prose)) return "bold italic text";
    if (QUOTE.test(line)) {
      if (BLANK_QUOTE.test(line)) return "quotes of more than one paragraph";
      previous = "other";
      continue;
    }
    if (RULE.test(line) || HEADING.test(line)) {
      previous = "other";
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (item[1]) return "nested or continued list items";
      if (item[2] !== undefined) {
        if (!ordered && Number(item[2]) !== 1) return "numbered lists that don't start at 1";
        ordered = true;
      } else ordered = false;
      previous = "list";
      continue;
    }
    if (previous === "list") return "nested or continued list items";
    previous = "paragraph";
  }
  return null;
}
