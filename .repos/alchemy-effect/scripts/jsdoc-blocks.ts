/**
 * Source-mapped JSDoc prose, shared by the API reference generator and the
 * website's dev-time copy editor.
 *
 * The generator renders a resource's JSDoc as a markdown page. With copy
 * markers on:
 *
 * - each prose region (the summary, a section's description, an example's
 *   body) is wrapped in a `<div data-copy="jsdoc:<file>@<comment>#r<n>"
 *   data-copy-format="markdown">` the copy editor edits as markdown source;
 * - each remaining one-line block (section and example titles) ends with a
 *   `<!--copy:jsdoc:<file>@<comment>#<n>-->` marker for inline text edits.
 *
 * Saving re-derives the same regions and blocks from the source file to find
 * what to rewrite, so both sides MUST segment comments with
 * {@link docRegions} and {@link docBlocks}.
 */

export interface DocLine {
  /** The line with its ` * ` prefix removed (what the generator parses). */
  text: string;
  /** Source offset where the raw line (including its ` * ` prefix) starts. */
  lineStart: number;
  /** Source offset where `text` starts. */
  start: number;
  /** Source offset where `text` ends. */
  end: number;
}

/**
 * Splits the `/** ... *\/` comment at `commentStart` into cleaned lines with
 * source offsets. Cleaning matches the generator's historical behavior.
 */
export function docCommentLines(
  fileText: string,
  commentStart: number,
): DocLine[] {
  if (!fileText.startsWith("/*", commentStart)) {
    throw new Error(`No doc comment at offset ${commentStart}`);
  }
  const close = fileText.indexOf("*/", commentStart + 2);
  if (close === -1)
    throw new Error(`Unterminated doc comment at ${commentStart}`);
  const raw = fileText.slice(commentStart, close + 2);
  const open = /^\/\*\*?/.exec(raw)![0].length;
  const body = raw.slice(open, raw.length - 2);
  const lines: DocLine[] = [];
  let offset = commentStart + open;
  for (const line of body.split("\n")) {
    const prefix = /^\s*\*\s?/.exec(line)?.[0].length ?? 0;
    lines.push({
      text: line.slice(prefix),
      lineStart: offset,
      start: offset + prefix,
      end: offset + line.length,
    });
    offset += line.length + 1;
  }
  return lines;
}

export type DocBlockKind =
  | "paragraph"
  | "listItem"
  | "heading"
  | "proseHeading"
  | "sectionTitle"
  | "exampleTitle";

export interface DocBlock {
  kind: DocBlockKind;
  firstLine: number;
  lastLine: number;
  /** Source range of the block's editable inline markdown. */
  start: number;
  end: number;
}

const FENCE = /^\s*```/;
const PROSE_HEADING = /^(\s*###\s+)(.+?)\s+<!-- api-prose -->\s*$/;
const SECTION = /^(\s*###\s+)(.+?)\s*$/;
const EXAMPLE = /^(\s*\*\*Example:\*\*\s*)(.*?)\s*$/;
const TAG = /^\s*@(\w+)/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)/;
const HEADING = /^(\s*#{1,6}\s+)/;
/** Lines that aren't inline prose: tables, HTML, directives, quotes, rules. */
const NON_PROSE = /^\s*(?:\||<|:::|>|---+\s*$|\*\*\*+\s*$)/;

/**
 * Finds the rendered prose blocks in a comment's lines, mirroring how the
 * generator's `parseJSDoc` routes each line (summary, section description,
 * example body, tag) so only lines that reach the page become blocks.
 */
export function docBlocks(lines: DocLine[]): DocBlock[] {
  const blocks: DocBlock[] = [];
  let sawTag = false;
  let inExample = false;
  let inSectionDesc = false;
  let insideFence = false;
  let open: DocBlock | undefined;

  const close = () => {
    if (open) blocks.push(open);
    open = undefined;
  };
  const single = (kind: DocBlockKind, i: number, from: number, to: number) => {
    close();
    const line = lines[i];
    if (to > from) {
      blocks.push({
        kind,
        firstLine: i,
        lastLine: i,
        start: line.start + from,
        end: line.start + to,
      });
    }
  };

  lines.forEach((line, i) => {
    const text = line.text;
    if (FENCE.test(text)) {
      insideFence = !insideFence;
      close();
      return;
    }
    if (insideFence) return;

    const prose = PROSE_HEADING.exec(text);
    if (prose) {
      if (!sawTag)
        single(
          "proseHeading",
          i,
          prose[1].length,
          prose[1].length + prose[2].length,
        );
      else close();
      return;
    }
    const section = SECTION.exec(text);
    if (section) {
      sawTag = true;
      inExample = false;
      inSectionDesc = true;
      single(
        "sectionTitle",
        i,
        section[1].length,
        section[1].length + section[2].length,
      );
      return;
    }
    const example = EXAMPLE.exec(text);
    if (example) {
      sawTag = true;
      inSectionDesc = false;
      inExample = true;
      single(
        "exampleTitle",
        i,
        example[1].length,
        example[1].length + example[2].length,
      );
      return;
    }
    const tag = TAG.exec(text);
    if (tag) {
      sawTag = true;
      if (tag[1] === "section") {
        inExample = false;
        inSectionDesc = true;
      } else if (tag[1] === "example") {
        inSectionDesc = false;
        inExample = true;
      }
      close();
      return;
    }

    const rendered = !sawTag || (!inExample && inSectionDesc);
    if (!rendered || text.trim() === "" || NON_PROSE.test(text)) {
      close();
      return;
    }

    const trimmedEnd = text.trimEnd().length;
    const heading = HEADING.exec(text);
    if (heading) {
      single("heading", i, heading[1].length, trimmedEnd);
      return;
    }
    const item = LIST_ITEM.exec(text);
    if (item) {
      close();
      open = {
        kind: "listItem",
        firstLine: i,
        lastLine: i,
        start: line.start + item[1].length,
        end: line.start + trimmedEnd,
      };
      return;
    }
    if (open) {
      open.lastLine = i;
      open.end = line.start + trimmedEnd;
      return;
    }
    const indent = text.length - text.trimStart().length;
    open = {
      kind: "paragraph",
      firstLine: i,
      lastLine: i,
      start: line.start + indent,
      end: line.start + trimmedEnd,
    };
  });
  close();
  return blocks;
}

// ── prose regions ─────────────────────────────────────────────────────────

export type DocRegionKind = "summary" | "sectionDescription" | "exampleBody";

export interface DocRegion {
  kind: DocRegionKind;
  /** First and last content line; `lastLine < firstLine` for an empty region. */
  firstLine: number;
  lastLine: number;
  /** For an empty region, the line new content is inserted after. */
  anchorLine: number;
  /** False when the region shares a line with the comment's delimiters. */
  editable: boolean;
}

type Route = "summary" | "sectionDescription" | "exampleBody" | "structural";

/**
 * Finds the prose regions in a comment's lines: runs of lines the generator
 * routes into one rendered chunk (summary, section description, example
 * body), trimmed of blank edge lines. A section title with no description
 * yields an empty region so a description can be added.
 */
export function docRegions(lines: DocLine[]): DocRegion[] {
  const routes: Route[] = [];
  let sawTag = false;
  let inExample = false;
  let inSectionDesc = false;
  let insideFence = false;
  const sectionTitles = new Set<number>();

  lines.forEach((line, i) => {
    const text = line.text;
    if (FENCE.test(text)) insideFence = !insideFence;
    if (!insideFence && !FENCE.test(text)) {
      if (PROSE_HEADING.test(text)) {
        routes.push(sawTag ? "structural" : "summary");
        return;
      }
      if (SECTION.test(text)) {
        sawTag = true;
        inExample = false;
        inSectionDesc = true;
        sectionTitles.add(i);
        routes.push("structural");
        return;
      }
      if (EXAMPLE.test(text)) {
        sawTag = true;
        inSectionDesc = false;
        inExample = true;
        routes.push("structural");
        return;
      }
      const tag = TAG.exec(text);
      if (tag) {
        sawTag = true;
        if (tag[1] === "section") {
          inExample = false;
          inSectionDesc = true;
        } else if (tag[1] === "example") {
          inSectionDesc = false;
          inExample = true;
        }
        routes.push("structural");
        return;
      }
    }
    routes.push(
      !sawTag
        ? "summary"
        : inExample
          ? "exampleBody"
          : inSectionDesc
            ? "sectionDescription"
            : "structural",
    );
  });

  const regions: DocRegion[] = [];
  const last = lines.length - 1;
  let i = 0;
  while (i < lines.length) {
    const route = routes[i]!;
    let j = i;
    while (j + 1 < lines.length && routes[j + 1] === route) j++;
    if (route !== "structural") {
      let first = i;
      let end = j;
      while (first <= end && lines[first]!.text.trim() === "") first++;
      while (end >= first && lines[end]!.text.trim() === "") end--;
      if (first <= end) {
        regions.push({
          kind: route,
          firstLine: first,
          lastLine: end,
          anchorLine: first - 1,
          editable: first > 0 && end < last,
        });
      } else if (route === "sectionDescription" && sectionTitles.has(i - 1)) {
        regions.push(emptyAfter(i - 1, last));
      }
    } else {
      // A section title followed directly by an example, tag, or section.
      for (let k = i; k <= j; k++) {
        if (sectionTitles.has(k) && routes[k + 1] !== "sectionDescription") {
          regions.push(emptyAfter(k, last));
        }
      }
    }
    i = j + 1;
  }
  return regions;
}

const emptyAfter = (anchorLine: number, last: number): DocRegion => ({
  kind: "sectionDescription",
  firstLine: anchorLine + 1,
  lastLine: anchorLine,
  anchorLine,
  editable: anchorLine < last,
});

/**
 * The copy-editable targets in a comment: prose regions (edited as markdown)
 * and the inline blocks outside editable regions (titles, edited as text).
 * Inline blocks are indexed among themselves so editing a region's markdown
 * never shifts their ids.
 */
export function docTargets(lines: DocLine[]) {
  const regions = docRegions(lines);
  const inRegion = (line: number) =>
    regions.some(
      (r) => r.editable && line >= r.firstLine && line <= r.lastLine,
    );
  const inline = docBlocks(lines).filter((b) => !inRegion(b.firstLine));
  return { regions, inline };
}

/** The region's markdown, as shown for editing. */
export const regionSource = (lines: DocLine[], region: DocRegion) =>
  lines
    .slice(region.firstLine, region.lastLine + 1)
    .map((l) => l.text)
    .join("\n");

/**
 * Returns `fileText` with `region` replaced by `markdown`, written as JSDoc
 * lines in the comment's own indentation.
 */
export function replaceRegion(
  fileText: string,
  lines: DocLine[],
  region: DocRegion,
  markdown: string,
): string {
  const reference =
    lines[
      region.lastLine >= region.firstLine ? region.firstLine : region.anchorLine
    ]!;
  const prefix = fileText
    .slice(reference.lineStart, reference.start)
    .replace(/\*\s*$/, "* ");
  const bare = prefix.trimEnd();

  let inCode = false;
  let insideFence = false;
  const body = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\s+$/g, "")
    .split("\n")
    // Outside code, one blank line separates blocks as well as several.
    .filter((line, i, all) => {
      if (FENCE.test(line)) inCode = !inCode;
      return inCode || line.trim() !== "" || all[i - 1]?.trim() !== "";
    })
    .map((line) => {
      if (FENCE.test(line)) insideFence = !insideFence;
      // Outside code, a leading `@` would start a JSDoc tag.
      const safe =
        !insideFence && /^\s*@/.test(line) ? line.replace("@", "\\@") : line;
      return safe.trim() === "" ? bare : `${prefix}${safe}`;
    });
  if (body.join("\n").includes("*/")) {
    throw new Error("Markdown in a JSDoc comment can't contain */.");
  }

  const empty = body.length === 1 && body[0] === bare;
  if (region.lastLine < region.firstLine) {
    if (empty) return fileText;
    const at = lines[region.anchorLine]!.end;
    return `${fileText.slice(0, at)}\n${body.join("\n")}${fileText.slice(at)}`;
  }
  const from = lines[region.firstLine]!.lineStart;
  if (empty) {
    // Drop the region's lines entirely, including their line breaks.
    const to = lines[region.lastLine + 1]!.lineStart;
    return fileText.slice(0, from) + fileText.slice(to);
  }
  const to = lines[region.lastLine]!.end;
  return fileText.slice(0, from) + body.join("\n") + fileText.slice(to);
}

// ── copy markers ──────────────────────────────────────────────────────────

export const JSDOC_COPY_SCHEME = "jsdoc";

/** Matches what follows `\n` on a JSDoc continuation line (` * `). */
export const JSDOC_LINE_PREFIX = "[ \\t]*\\*(?!/)[ \\t]?";

/** Style preset the website applies to previews of edited JSDoc markdown. */
export const JSDOC_COPY_STYLE = "docs";

export const jsdocCopyId = (
  file: string,
  commentStart: number,
  target: `${number}` | `r${number}`,
) => `${JSDOC_COPY_SCHEME}:${file}@${commentStart}#${target}`;

export const parseJsdocCopyId = (id: string) => {
  const m = /^jsdoc:(.+)@(\d+)#(r?)(\d+)$/.exec(id);
  if (!m) return undefined;
  const base = { file: m[1]!, commentStart: Number(m[2]) };
  return m[3]
    ? { ...base, region: Number(m[4]) }
    : { ...base, block: Number(m[4]) };
};

const REGION_CLOSE = "</div><!--/copy-->";
const COPY_MARKUP_RE = new RegExp(
  `<!--copy:[^>]*?-->|^<div data-copy=[^\\n]*>$|^${REGION_CLOSE.replace(/[/]/g, "\\/")}$`,
  "gm",
);

/** Removes copy markers and region wrappers from generated markdown. */
export const stripCopyMarkers = (text: string) =>
  text.replace(COPY_MARKUP_RE, "");

/**
 * Returns the comment's cleaned line texts with copy markup added: region
 * wrappers around each editable prose region, and a trailing marker on each
 * title block outside them.
 */
export function markDocLines(
  lines: DocLine[],
  idFor: (target: `${number}` | `r${number}`) => string,
): string[] {
  const texts = lines.map((l) => l.text);
  const { regions, inline } = docTargets(lines);

  inline.forEach((block, index) => {
    const marker = `<!--copy:${idFor(`${index}`)}-->`;
    const text = texts[block.lastLine]!;
    const prose = /\s+<!-- api-prose -->\s*$/.exec(text);
    texts[block.lastLine] = prose
      ? `${text.slice(0, prose.index).trimEnd()}${marker}${prose[0]}`
      : `${text.trimEnd()}${marker}`;
  });

  const before = new Map<number, string[]>();
  const after = new Map<number, string[]>();
  const add = (map: Map<number, string[]>, line: number, add: string[]) =>
    map.set(line, [...(map.get(line) ?? []), ...add]);
  regions.forEach((region, index) => {
    if (!region.editable) return;
    const open = `<div data-copy="${idFor(`r${index}`)}" data-copy-format="markdown" data-copy-style="${JSDOC_COPY_STYLE}">`;
    if (region.lastLine < region.firstLine) {
      add(after, region.anchorLine, ["", open, REGION_CLOSE]);
    } else {
      add(before, region.firstLine, [open, ""]);
      add(after, region.lastLine, ["", REGION_CLOSE]);
    }
  });
  return texts.flatMap((text, i) => [
    ...(before.get(i) ?? []),
    text,
    ...(after.get(i) ?? []),
  ]);
}

// ── {@link} tags ──────────────────────────────────────────────────────────

export const LINK_TAG_RE = /\{@link\s+([^}]+)\}/g;

/** Split a `{@link ...}` tag's inner text into target + optional label. */
export function parseLinkTag(inner: string): {
  target: string;
  label?: string;
} {
  const trimmed = inner.trim();
  const pipe = trimmed.indexOf("|");
  if (pipe !== -1) {
    return {
      target: trimmed.slice(0, pipe).trim(),
      label: trimmed.slice(pipe + 1).trim() || undefined,
    };
  }
  const space = trimmed.search(/\s/);
  if (space !== -1) {
    return {
      target: trimmed.slice(0, space).trim(),
      label: trimmed.slice(space + 1).trim() || undefined,
    };
  }
  return { target: trimmed };
}

/**
 * Reduce a typedoc-style `import("./Secrets.ts").Secrets` target to the bare
 * symbol name — resolution (same-directory first) and display both want the
 * name, not the module expression.
 */
export function normalizeLinkTarget(target: string): string {
  const match = target.match(/^import\((["'])[^"']+\1\)\.(.+)$/);
  return match ? match[2] : target;
}

/** The text a `{@link}` tag renders as (its label, or the bare target). */
export function linkTagText(inner: string): string {
  const { target, label } = parseLinkTag(inner.replace(/\s+/g, " "));
  return label ?? normalizeLinkTarget(target);
}
