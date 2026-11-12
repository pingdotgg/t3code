import { sourceControlClients, type ReferenceAutolink } from "./sourceControlClients.ts";

/** `id` is positional on purpose: the same attachment can be embedded twice in one body. */
export type PullRequestBodySegment =
  | {
      readonly id: string;
      readonly kind: "markdown";
      readonly text: string;
      /** Where `text` starts in the body, so an edit made to it can be written back. */
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
    }
  | {
      readonly id: string;
      readonly kind: "details";
      readonly open: boolean;
      /** The `<summary>` contents as written, empty when the fold has none. */
      readonly summary: string;
      readonly segments: ReadonlyArray<PullRequestBodySegment>;
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
const DETAILS_START_PATTERN = /^\s*<details\b/iu;
const DETAILS_END_PATTERN = /<\/details\s*>\s*$/iu;
const DETAILS_OPEN_PATTERN = /<details\b/giu;
const DETAILS_CLOSE_PATTERN = /<\/details\s*>/giu;
/** Quoted values may hold `>`; the alternatives are disjoint, as in `TABLE_STRUCTURE_TAG_PATTERN`. */
const DETAILS_OPEN_TAG_PATTERN = /^\s*<details\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/iu;
/** Deeper folds stay markdown, so a crafted body cannot recurse once per nesting level. */
const DETAILS_MAX_DEPTH = 8;
const SUMMARY_PATTERN = /^\s*<summary\b(?:[^<>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/summary\s*>/iu;
/** A one-line link reference definition, which markdown resolves across the whole body. */
const REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*\S/u;

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
function tableRows(html: string, htmlOffset: number, foldDepth: number): TableRows | null {
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
        segments: splitBodyAt(content, htmlOffset + cell.contentStart, foldDepth),
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
  foldDepth: number,
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
  const rows = tableRows(lines.slice(start, end + 1).join("\n"), startOffset, foldDepth);
  const hasMedia = rows?.some((cells) =>
    cells.some((cell) => cell.segments.some((segment) => segment.kind !== "markdown")),
  );
  return { end, rows: hasMedia ? rows : null };
}

/**
 * The fold opening at `start`, through its matching close, when lifting media out of it left
 * something besides markdown: a renderer draws each segment on its own, so a fold split around
 * a video would close before it. `end` is the last line looked at, as for `mediaTableAt`.
 */
function mediaDetailsAt(
  lines: ReadonlyArray<string>,
  start: number,
  startOffset: number,
  foldDepth: number,
): {
  end: number;
  segment: Omit<Extract<PullRequestBodySegment, { kind: "details" }>, "id"> | null;
} {
  let depth = 0;
  let end = start;
  let openFence: string | null = null;
  for (; end < lines.length; end += 1) {
    const line = lines[end]!;
    const fence = fenceAfter(openFence, line);
    if (fence !== undefined) {
      openFence = fence;
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) continue;
    depth +=
      (line.match(DETAILS_OPEN_PATTERN)?.length ?? 0) -
      (line.match(DETAILS_CLOSE_PATTERN)?.length ?? 0);
    if (depth <= 0) break;
  }
  end = Math.min(end, lines.length - 1);
  if (depth !== 0 || !DETAILS_END_PATTERN.test(lines[end]!)) return { end, segment: null };
  const html = lines.slice(start, end + 1).join("\n");
  const openTag = DETAILS_OPEN_TAG_PATTERN.exec(html);
  if (openTag === null) return { end, segment: null };
  let bodyStart = openTag[0].length;
  const summary = SUMMARY_PATTERN.exec(html.slice(bodyStart));
  if (summary !== null) bodyStart += summary[0].length;
  const bodyEnd = html.search(DETAILS_END_PATTERN);
  if (bodyEnd < bodyStart) return { end, segment: null };
  const segments = splitBodyAt(
    html.slice(bodyStart, bodyEnd),
    startOffset + bodyStart,
    foldDepth + 1,
  );
  if (segments.every((segment) => segment.kind === "markdown")) return { end, segment: null };
  return {
    end,
    segment: {
      kind: "details",
      // Quoted values are blanked so `title="is open"` does not count as the attribute.
      open: /\sopen\b/iu.test(openTag[1]!.replace(/"[^"]*"|'[^']*'/gu, '""')),
      summary: summary?.[1]!.trim() ?? "",
      segments,
    },
  };
}

/**
 * The open fence after `line`, or undefined when `line` is not a fence. A fence closes only on
 * the same marker, at least as long as the one that opened it, and with nothing after it:
 * `~~~` cannot end a ``` block, and ```` ```ts ```` is an info string opening a nested fence.
 */
function fenceAfter(openFence: string | null, line: string): string | null | undefined {
  const fenceMatch = FENCE_PATTERN.exec(line);
  if (fenceMatch === null) return undefined;
  const fence = fenceMatch[1]!;
  if (openFence === null) return fence;
  const closes =
    fence[0] === openFence[0] &&
    fence.length >= openFence.length &&
    fenceMatch[2]!.trim().length === 0;
  return closes ? null : openFence;
}

export function splitPullRequestBody(body: string): ReadonlyArray<PullRequestBodySegment> {
  const segments = splitBodyAt(body, 0, 0);
  if (!segments.some((segment) => segment.kind === "details")) return segments;
  // A fold renders apart from the body around it, so its prose gets the body's definitions.
  const definitions: string[] = [];
  let openFence: string | null = null;
  for (const line of body.split("\n")) {
    const fence = fenceAfter(openFence, line);
    if (fence !== undefined) openFence = fence;
    else if (openFence === null && REFERENCE_DEFINITION_PATTERN.test(line)) {
      definitions.push(line.replace(/\r$/u, ""));
    }
  }
  if (definitions.length === 0) return segments;
  const suffix = `\n\n${definitions.join("\n")}`;
  const withDefinitions = (segment: PullRequestBodySegment): PullRequestBodySegment =>
    segment.kind === "markdown"
      ? { ...segment, text: segment.text + suffix }
      : segment.kind === "details"
        ? { ...segment, segments: segment.segments.map(withDefinitions) }
        : segment;
  return segments.map((segment) =>
    segment.kind === "details" ? withDefinitions(segment) : segment,
  );
}

/** `baseOffset` is where `body` starts in the whole body, so a table cell's edits write back. */
function splitBodyAt(
  body: string,
  baseOffset: number,
  foldDepth: number,
): ReadonlyArray<PullRequestBodySegment> {
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
  let detailsScannedThrough = -1;
  let lineStart = baseOffset;
  for (let index = 0; index < lines.length; lineStart += lines[index]!.length + 1, index += 1) {
    const line = lines[index]!;
    if (markdown.length === 0) markdownStart = lineStart;
    const fence = fenceAfter(openFence, line);
    if (fence !== undefined) {
      openFence = fence;
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    if (index > tableScannedThrough && TABLE_START_PATTERN.test(line)) {
      const table = mediaTableAt(lines, index, lineStart, foldDepth);
      tableScannedThrough = table.end;
      if (table.rows !== null) {
        flushMarkdown();
        segments.push({ id: `table:${segments.length}`, kind: "table", rows: table.rows });
        for (; index < table.end; index += 1) lineStart += lines[index]!.length + 1;
        continue;
      }
    }

    if (
      foldDepth < DETAILS_MAX_DEPTH &&
      index > detailsScannedThrough &&
      DETAILS_START_PATTERN.test(line)
    ) {
      const details = mediaDetailsAt(lines, index, lineStart, foldDepth);
      detailsScannedThrough = details.end;
      if (details.segment !== null) {
        flushMarkdown();
        segments.push({ id: `details:${segments.length}`, ...details.segment });
        for (; index < details.end; index += 1) lineStart += lines[index]!.length + 1;
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
