import { markdownLinkDestinationScanner } from "@t3tools/shared/markdownLinks";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { GITHUB_EMOJI_ALIASES } from "./githubEmojiAliases.ts";
import { sourceControlClients } from "./sourceControlClients.ts";

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
      readonly label?: string;
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
// The marker is the whole run, so a line that is no fence is given up on in one pass.
// A fence may open right after a list marker: `- ```ts` starts code inside the item.
const FENCE_PATTERN = /^\s{0,3}(?:(?:[-+*]|\d{1,9}[.)]) {1,4})?(`{3,}(?!`)|~{3,}(?!~))(.*)\r?$/u;
const LIST_ITEM_PATTERN = /^\s{0,3}(?:[-+*]|\d{1,9}[.)]) /u;

/** Tabs advance to the next multiple of four, as Markdown measures indentation. */
function indentColumns(line: string): number {
  let column = 0;
  for (const char of /^[ \t]*/u.exec(line)![0]) column += char === "\t" ? 4 - (column % 4) : 1;
  return column;
}

/**
 * How far a `<video>` tag may reach for its closing tag. Real embeds are one to three lines,
 * and the bound keeps an unclosed tag from making each one rescan the rest of the body.
 */
const VIDEO_TAG_MAX_LINES = 8;

// A tab after up to three spaces still reaches the fourth column.
const INDENTED_CODE_PATTERN = /^(?: {4}| {0,3}\t)/u;
const HTML_COMMENT_START_PATTERN = /^ {0,3}<!--/u;
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)$/iu;
// A destination unescapes backslashed ASCII punctuation and decodes character references
// (`&amp;`); a link with a reference stays Markdown so its parser decodes it.
const MARKDOWN_DESTINATION_TOKEN_PATTERN =
  /\\([!-/:-@[-`{-~])|&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/gu;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)$/iu;

// Stops at the next `<`, so matching stays linear in the length of the line.
const VIDEO_SOURCE_TAG_PATTERN = /<(?:video|source)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/giu;
const HTML_ATTRIBUTE_PATTERN = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/gu;
const HTML_AMPERSAND_REFERENCE_PATTERN = /&(?:amp|AMP|#0*38|#[xX]0*26);/gu;

function videoTagSource(html: string): string | undefined {
  for (const tag of html.matchAll(VIDEO_SOURCE_TAG_PATTERN)) {
    for (const attribute of tag[1]!.matchAll(HTML_ATTRIBUTE_PATTERN)) {
      if (attribute[1]!.toLowerCase() !== "src") continue;
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (value) return value.replace(HTML_AMPERSAND_REFERENCE_PATTERN, "&");
    }
  }
  return undefined;
}

const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;
const VIDEO_TAG_CLOSE_PATTERN = /<\/video>/iu;

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

function webUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

function standaloneMarkdownLink(trimmed: string): { label: string; url: string } | null {
  if (!trimmed.startsWith("[")) return null;
  const closeBracket = trimmed.indexOf("]");
  if (closeBracket < 0 || trimmed[closeBracket + 1] !== "(") return null;
  const destination = markdownLinkDestinationScanner(trimmed)(closeBracket + 1);
  if (destination === null || destination.end !== trimmed.length) return null;
  let hasCharacterReference = false;
  const url = trimmed
    .slice(destination.hrefStart, destination.hrefEnd)
    .replace(MARKDOWN_DESTINATION_TOKEN_PATTERN, (token, escaped: string | undefined) => {
      if (escaped !== undefined) return escaped;
      hasCharacterReference = true;
      return token;
    });
  return url && !hasCharacterReference ? { label: trimmed.slice(1, closeBracket), url } : null;
}

function attachmentFromLine(
  line: string,
): Omit<Extract<PullRequestBodySegment, { kind: "attachment" }>, "id" | "kind"> | null {
  const trimmed = line.trim();
  const link = standaloneMarkdownLink(trimmed);
  const url = link?.url ?? BARE_URL_PATTERN.exec(trimmed)?.[1];
  if (url === undefined) return null;
  // Only the path names the file: `report?file=demo.mp4` is a page, not a video.
  const path = webUrl(url)?.pathname;
  if (path === undefined) return null;
  const media = VIDEO_EXTENSION_PATTERN.test(path)
    ? "video"
    : IMAGE_EXTENSION_PATTERN.test(path)
      ? "image"
      : sourceControlClients.mediaUrl(url)?.kind;
  if (media === undefined) return null;
  const label = link?.label.trim();
  return label ? { url, media, label } : { url, media };
}

export function makePullRequestMediaKindAtom(
  fetchMedia: (
    url: string,
    options: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<Pick<Response, "ok" | "headers" | "body">>,
) {
  return Atom.family((url: string | null) =>
    Atom.make(
      Effect.promise(async (signal) => {
        if (url === null) return null;
        try {
          const response = await fetchMedia(url, { headers: { Range: "bytes=0-0" }, signal });
          void response.body?.cancel().catch(() => undefined);
          if (!response.ok) return null;
          const type = response.headers.get("content-type")?.trim().toLowerCase();
          if (type?.startsWith("image/")) return "image" as const;
          if (type?.startsWith("video/")) return "video" as const;
          return null;
        } catch {
          return null;
        }
      }),
    ),
  );
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
  const bomLength = segment.sourceOffset === 0 && segment.text.startsWith("\uFEFF") ? 1 : 0;
  return {
    ...segment,
    text: definitions + segment.text.slice(bomLength),
    sourceOffset: segment.sourceOffset + bomLength - definitions.length,
  };
}

/**
 * The first definition of each label in a body, each on one line so it stands outside the quote or
 * list it was written in, as the client's Markdown parser reads them.
 */
export type FindReferenceDefinitions = (body: string) => ReadonlyArray<string>;

/** How much text the body's definitions may add across all the segments that lead with them. */
const DEFINITIONS_MAX_ADDED_LENGTH = 256 * 1024;

function segmentsWithReferences(segments: ReadonlyArray<PullRequestBodySegment>): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.kind === "markdown") count += segment.text.includes("[") ? 1 : 0;
    else if (segment.kind === "table") {
      for (const cells of segment.rows)
        for (const cell of cells) count += segmentsWithReferences(cell.segments);
    }
  }
  return count;
}

export function splitPullRequestBody(
  body: string,
  findDefinitions: FindReferenceDefinitions,
): ReadonlyArray<PullRequestBodySegment> {
  const segments = splitBodyAt(body, 0);
  // One markdown segment is the whole body, which resolves its own references.
  const whole = segments.length === 1 && segments[0]!.kind === "markdown";
  if (whole || !body.includes("]:")) return segments;
  const definitions = findDefinitions(body);
  if (definitions.length === 0) return segments;
  const leading = `${definitions.join("\n")}\n\n`;
  // Past the budget the body renders as one document: its media stays links, its references resolve.
  if (leading.length * segmentsWithReferences(segments) > DEFINITIONS_MAX_ADDED_LENGTH) {
    const text = body.replace(/^(?:\r|\n)+/u, "");
    return [
      {
        id: "markdown:0",
        kind: "markdown",
        text: text.trimEnd(),
        sourceOffset: body.length - text.length,
      },
    ];
  }
  return segments.map((segment) => withDefinitions(segment, leading));
}

/** `baseOffset` is where `body` starts in the whole body, so a table cell's edits write back. */
function splitBodyAt(body: string, baseOffset: number): ReadonlyArray<PullRequestBodySegment> {
  const segments: PullRequestBodySegment[] = [];
  const markdown: string[] = [];
  let markdownStart = 0;
  let openFence: {
    readonly marker: string;
    readonly flushLeft: boolean;
    /** Columns of a list item the fence opened in; a less indented line ends the item and fence. */
    readonly itemIndent: number;
  } | null = null;
  let openComment = false;

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
        text: text.trimEnd(),
        sourceOffset,
      });
    }
  };

  const lines = body.replace(/\r(?!\n)/gu, "\n").split("\n");
  let tableScannedThrough = -1;
  let lineStart = baseOffset;
  for (let index = 0; index < lines.length; lineStart += lines[index]!.length + 1, index += 1) {
    const line = lines[index]!;
    if (markdown.length === 0) markdownStart = lineStart;
    if (openComment) {
      if (line.includes("-->")) {
        openComment = false;
      }
      markdown.push(line);
      continue;
    }
    if (
      openFence !== null &&
      openFence.itemIndent > 0 &&
      line.trim() &&
      indentColumns(line) < openFence.itemIndent
    ) {
      openFence = null;
    }
    const fenceMatch = FENCE_PATTERN.exec(line);
    // ```` ```npm test``` ```` is a code span, not an opener that would flip every later fence.
    // A span that runs past this line is left an opener, so its lines stay out of media.
    const isInlineCode =
      openFence === null &&
      fenceMatch?.[1]![0] === "`" &&
      (fenceMatch[2]!.match(/`+/gu) ?? []).some((run) => run.length === fenceMatch[1]!.length);
    if (fenceMatch !== null && !isInlineCode) {
      const fence = fenceMatch[1]!;
      // A fence closes only on the same marker, at least as long as the one that opened it,
      // and with nothing after it: `~~~` cannot end a ``` block, and ```` ```ts ```` is an
      // info string opening a nested fence, not a close. Under a fence opened at the margin, an
      // indented-code line is content too: a tab-indented ``` there is part of the example.
      const closes =
        openFence !== null &&
        fence[0] === openFence.marker[0] &&
        fence.length >= openFence.marker.length &&
        fenceMatch[2]!.trim().length === 0 &&
        !LIST_ITEM_PATTERN.test(line) &&
        !(openFence.flushLeft && INDENTED_CODE_PATTERN.test(line));
      if (openFence === null) {
        openFence = {
          marker: fence,
          flushLeft: line.startsWith(fence),
          itemIndent: LIST_ITEM_PATTERN.test(line) ? line.indexOf(fence) : 0,
        };
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
    if (HTML_COMMENT_START_PATTERN.test(line)) {
      openComment = !line.includes("-->");
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
    while (cursor < lastCandidate && !VIDEO_TAG_CLOSE_PATTERN.test(lines[cursor]!)) {
      cursor += 1;
    }
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor]!)
      ? videoTagSource(lines.slice(index, cursor + 1).join("\n"))
      : undefined;
    if (source !== undefined && webUrl(source) !== null) {
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
let githubEmojiByAlias: ReadonlyMap<string, string> | undefined;
const githubEmojiAlias = /:([a-z\d_+-]+)(?=:)/gu;

/** GitHub's `:alias:` emoji in `text`; a colon closes one alias only, so `:tada:tada:` has one. */
export function githubEmojiAliases(
  text: string,
): ReadonlyArray<{ readonly index: number; readonly text: string; readonly emoji: string }> {
  githubEmojiByAlias ??= new Map(
    GITHUB_EMOJI_ALIASES.trim()
      .split("\n")
      .map((line) => {
        const space = line.indexOf(" ");
        return [line.slice(0, space), line.slice(space + 1)] as const;
      }),
  );
  const found: { index: number; text: string; emoji: string }[] = [];
  let end = 0;
  for (const match of text.matchAll(githubEmojiAlias)) {
    const emoji = githubEmojiByAlias.get(match[1]!);
    if (emoji === undefined || match.index < end) continue;
    end = match.index + match[0].length + 1;
    found.push({ index: match.index, text: `${match[0]}:`, emoji });
  }
  return found;
}

export function expandGithubEmojiAliases(text: string): string {
  let expanded = "";
  let start = 0;
  for (const alias of githubEmojiAliases(text)) {
    expanded += text.slice(start, alias.index) + alias.emoji;
    start = alias.index + alias.text.length;
  }
  return start === 0 ? text : expanded + text.slice(start);
}
