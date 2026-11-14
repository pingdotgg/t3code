import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { sourceControlClients, type ReferenceAutolink } from "./sourceControlClients.ts";

/** `id` is positional on purpose: the same attachment can be embedded twice in one body. */
export type PullRequestBodySegment =
  | {
      readonly id: string;
      readonly kind: "markdown";
      readonly text: string;
      /**
       * `sourceOffset + i` is where `text[i]` sits in the body, so an edit can be written back.
       * Holds past the body's reference definitions, which `text` may lead with.
       */
      readonly sourceOffset: number;
    }
  | {
      readonly id: string;
      readonly kind: "attachment";
      readonly url: string;
      readonly media: "video" | "image" | "unknown";
    }
  | {
      readonly id: string;
      readonly kind: "table";
      readonly rows: ReadonlyArray<ReadonlyArray<PullRequestBodyTableCell>>;
    };

type PullRequestBodyTableCell = {
  readonly header: boolean;
  readonly segments: ReadonlyArray<PullRequestBodySegment>;
};

// `.` stops at the `\r` of a CRLF body, which is how GitHub stores one written in its web editor.
const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)\r?$/u;
/**
 * How far a `<video>` tag may reach for its closing tag. Real embeds are one to three lines,
 * and the bound keeps an unclosed tag from making each one rescan the rest of the body.
 */
const VIDEO_TAG_MAX_LINES = 8;

// A tab after up to three spaces still reaches the fourth column.
const INDENTED_CODE_PATTERN = /^(?: {4}| {0,3}\t)/u;
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)(?:$|[?#])/iu;
const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;

const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;

const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;

/** Bounded like `VIDEO_TAG_MAX_LINES`; room for a before/after table with several rows. */
const TABLE_MAX_LINES = 64;
const TABLE_START_PATTERN = /^\s*<table\b/iu;
const TABLE_END_PATTERN = /<\/table>\s*$/iu;
const TABLE_OPEN_PATTERN = /<table\b/giu;
const TABLE_CLOSE_PATTERN = /<\/table\s*>/giu;
/**
 * Quoted attribute values may hold `>`. The alternatives start on disjoint characters and an
 * unquoted run stops at the next `<`, so a run of unterminated tags stays linear.
 */
const TABLE_STRUCTURE_TAG_PATTERN =
  /<(\/?)(table|thead|tbody|tfoot|tr|td|th)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/giu;
/** Rows are laid out independently, so a spanning cell would shift the cells after it. */
const CELL_SPAN_PATTERN = /\b(?:col|row)span\b/iu;

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function attachmentFromLine(
  line: string,
): { url: string; media: "video" | "image" | "unknown" } | null {
  const url =
    BARE_URL_PATTERN.exec(line.trim())?.[1] ?? MARKDOWN_LINK_PATTERN.exec(line.trim())?.[1];
  if (url === undefined || !isWebUrl(url)) return null;
  if (VIDEO_EXTENSION_PATTERN.test(url) || sourceControlClients.mediaUrl(url)?.kind === "video") {
    return { url, media: "video" };
  }
  if (IMAGE_EXTENSION_PATTERN.test(url)) return { url, media: "image" };
  return null;
}

type TableRows = ReadonlyArray<ReadonlyArray<PullRequestBodyTableCell>>;

/**
 * Cells of a table made only of rows and cells, or null when anything else is in it: a caption,
 * text between cells, a nested table. Cell contents are split on their own, so tables never nest.
 */
function tableRows(html: string, htmlOffset: number): TableRows | null {
  const rows: PullRequestBodyTableCell[][] = [];
  let row: PullRequestBodyTableCell[] | null = null;
  let cell: { tag: string; contentStart: number } | null = null;
  let opened = false;
  let closed = false;
  let cursor = 0;
  for (const match of html.matchAll(TABLE_STRUCTURE_TAG_PATTERN)) {
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    if (cell !== null) {
      if (!closing || tag !== cell.tag) return null;
      const content = html.slice(cell.contentStart, match.index);
      // Indented HTML would render as a code block once the cell is markdown on its own.
      if (content.split("\n").some((line) => INDENTED_CODE_PATTERN.test(line) && line.trim()))
        return null;
      row!.push({
        header: tag === "th",
        segments: splitBodyAt(content, htmlOffset + cell.contentStart),
      });
      cell = null;
    } else {
      if (html.slice(cursor, match.index).trim().length > 0) return null;
      const tableOpen = opened && !closed;
      if (tag === "table") {
        if (closing ? !tableOpen || row !== null : opened) return null;
        opened = true;
        closed = closing;
      } else if (tag === "tr") {
        if (!tableOpen || closing === (row === null)) return null;
        if (closing) rows.push(row!);
        row = closing ? null : [];
      } else if (tag === "td" || tag === "th") {
        if (closing || row === null || CELL_SPAN_PATTERN.test(match[3]!)) return null;
        cell = { tag, contentStart: match.index + match[0].length };
      } else if (!tableOpen || row !== null) {
        return null;
      }
    }
    cursor = match.index + match[0].length;
  }
  if (!closed || html.slice(cursor).trim().length > 0) return null;
  return rows.filter((cells) => cells.length > 0);
}

/**
 * The table opening at `start`, through its matching close. `end` is the last line looked at
 * even when the table is not usable, so the caller never re-reads an inner table on its own.
 */
function mediaTableAt(
  lines: ReadonlyArray<string>,
  start: number,
  startOffset: number,
): { end: number; rows: TableRows | null } {
  const lastCandidate = Math.min(start + TABLE_MAX_LINES, lines.length) - 1;
  let depth = 0;
  let end = start;
  for (; ; end += 1) {
    const line = lines[end]!;
    depth +=
      (line.match(TABLE_OPEN_PATTERN)?.length ?? 0) -
      (line.match(TABLE_CLOSE_PATTERN)?.length ?? 0);
    if (depth <= 0 || end === lastCandidate) break;
  }
  if (depth !== 0 || !TABLE_END_PATTERN.test(lines[end]!)) return { end, rows: null };
  // Lifting attachment links out of a table's cells would tear the table apart.
  const rows = tableRows(lines.slice(start, end + 1).join("\n"), startOffset);
  const hasMedia = rows?.some((cells) =>
    cells.some((cell) => cell.segments.some((segment) => segment.kind === "attachment")),
  );
  return { end, rows: hasMedia ? rows : null };
}

const definitionParser = unified().use(remarkParse).use(remarkGfm);

/**
 * The first definition of each label in the body, as authored, each joined onto one line so it
 * stands outside the quote or list it was written in.
 */
function referenceDefinitions(body: string): string[] {
  const definitions = new Map<string, string>();
  const visit = (node: Root | RootContent, quotes: number) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      const wrap = new RegExp(`(?:\\r\\n|\\r|\\n)(?:[ \\t]*>){0,${quotes}}[ \\t]*`, "gu");
      const source = body.slice(node.position?.start.offset, node.position?.end.offset);
      definitions.set(node.identifier, source.replace(wrap, " "));
    }
    if (!("children" in node)) return;
    for (const child of node.children) visit(child, quotes + (node.type === "blockquote" ? 1 : 0));
  };
  visit(definitionParser.parse(body), 0);
  return [...definitions.values()];
}

/**
 * Each markdown segment renders as its own document, so it leads with the body's definitions.
 * Leading, they win over a later redefinition in the segment, as the first one does in the body.
 */
function withDefinitions(
  segment: PullRequestBodySegment,
  definitions: string,
): PullRequestBodySegment {
  if (segment.kind === "attachment") return segment;
  if (segment.kind === "table") {
    return {
      ...segment,
      rows: segment.rows.map((cells) =>
        cells.map((cell) => ({
          ...cell,
          segments: cell.segments.map((inner) => withDefinitions(inner, definitions)),
        })),
      ),
    };
  }
  if (!segment.text.includes("[")) return segment;
  return {
    ...segment,
    text: definitions + segment.text,
    sourceOffset: segment.sourceOffset - definitions.length,
  };
}

export function splitPullRequestBody(body: string): ReadonlyArray<PullRequestBodySegment> {
  const segments = splitBodyAt(body, 0);
  // One markdown segment is the whole body, which resolves its own references.
  const whole = segments.length === 1 && segments[0]!.kind === "markdown";
  if (whole || !body.includes("]:")) return segments;
  const definitions = referenceDefinitions(body);
  if (definitions.length === 0) return segments;
  const leading = `${definitions.join("\n")}\n\n`;
  return segments.map((segment) => withDefinitions(segment, leading));
}

/** `baseOffset` is where `body` starts in the whole body, so a table cell's edits write back. */
function splitBodyAt(body: string, baseOffset: number): ReadonlyArray<PullRequestBodySegment> {
  const segments: PullRequestBodySegment[] = [];
  const markdown: string[] = [];
  let markdownStart = 0;
  let openFence: string | null = null;

  // Blank lines around a run are dropped, but never leading spaces: four of them open an
  // indented code block, so trimming a run would silently turn code into prose.
  const flushMarkdown = () => {
    const joined = markdown.join("\n");
    const text = joined.replace(/^(?:\r?\n)+/u, "");
    const sourceOffset = markdownStart + joined.length - text.length;
    markdown.length = 0;
    if (text.trim().length > 0) {
      segments.push({
        id: `markdown:${segments.length}`,
        kind: "markdown",
        text: text.replace(/\s+$/u, ""),
        sourceOffset,
      });
    }
  };

  const lines = body.split("\n");
  let tableScannedThrough = -1;
  let lineStart = baseOffset;
  for (let index = 0; index < lines.length; lineStart += lines[index]!.length + 1, index += 1) {
    const line = lines[index]!;
    if (markdown.length === 0) markdownStart = lineStart;
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch !== null) {
      const fence = fenceMatch[1]!;
      // A fence closes only on the same marker, at least as long as the one that opened it,
      // and with nothing after it: `~~~` cannot end a ``` block, and ```` ```ts ```` is an
      // info string opening a nested fence, not a close.
      const closes =
        openFence !== null &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        fenceMatch[2]!.trim().length === 0;
      if (openFence === null) {
        openFence = fence;
      } else if (closes) {
        openFence = null;
      }
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    if (index > tableScannedThrough && TABLE_START_PATTERN.test(line)) {
      const table = mediaTableAt(lines, index, lineStart);
      tableScannedThrough = table.end;
      if (table.rows !== null) {
        flushMarkdown();
        segments.push({ id: `table:${segments.length}`, kind: "table", rows: table.rows });
        for (; index < table.end; index += 1) lineStart += lines[index]!.length + 1;
        continue;
      }
    }

    const bareAttachment = attachmentFromLine(line);
    if (bareAttachment !== null) {
      flushMarkdown();
      segments.push({ id: `attachment:${segments.length}`, kind: "attachment", ...bareAttachment });
      continue;
    }

    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }
    const lastCandidate = Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1;
    let cursor = index;
    while (cursor < lastCandidate && !VIDEO_TAG_END_PATTERN.test(lines[cursor]!)) {
      cursor += 1;
    }
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor]!)
      ? VIDEO_TAG_SRC_PATTERN.exec(lines.slice(index, cursor + 1).join("\n"))?.[1]
      : undefined;
    if (source !== undefined && isWebUrl(source)) {
      flushMarkdown();
      segments.push({
        id: `attachment:${segments.length}`,
        kind: "attachment",
        url: source,

        media: "video",
      });
      for (; index < cursor; index += 1) lineStart += lines[index]!.length + 1;
    } else {
      // Unclosed, or nothing linkable in it: prose. Only this line is consumed, so the
      // lines that were looked at are still parsed on their own terms.
      markdown.push(line);
    }
  }

  flushMarkdown();
  return segments;
}

/**
 * Finds the references the change request's host links in plain text, resolved against the change
 * request's repository. Null when the host links none.
 */
export function changeRequestReferenceAutolinker(
  changeRequest: { readonly provider: string; readonly url: string } | null | undefined,
): ((text: string) => ReadonlyArray<ReferenceAutolink>) | null {
  if (!changeRequest) return null;
  const find = sourceControlClients.get(changeRequest.provider).referenceAutolinks;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  return find === undefined || repositoryUrl === undefined
    ? null
    : (text) => find(text, repositoryUrl);
}

/**
 * Forges link uploads root-relative, as GitCafe's `/api/attachments/<id>`. In a change request
 * body that always means the forge's origin, never a path on the machine rendering it.
 */
export function resolveChangeRequestMediaUrl(url: string, changeRequestUrl: string): string {
  if (!/^\/(?![/\\])/u.test(url)) return url;
  try {
    return new URL(url, changeRequestUrl).href;
  } catch {
    return url;
  }
}
