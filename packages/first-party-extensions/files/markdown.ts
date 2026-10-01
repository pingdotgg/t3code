/**
 * Minimal safe markdown parser for the Files preview. The native
 * FileMarkdownPreview renders through ChatMarkdown (react-markdown + GFM +
 * raw-HTML sanitize) — that dependency tree cannot bundle into an extension
 * (the build bans react-dom; the import audit bans every app-private
 * specifier). This parser produces a plain-data block tree the view maps to
 * host-React elements, so every byte of source text is escaped by React:
 * there is no raw-HTML path at all.
 *
 * Deliberate limits vs the native renderer (named in the UI caption):
 * no raw HTML passthrough, no GFM tables/footnotes/alerts, no fence syntax
 * highlighting, no workspace image resolution, task-list checkboxes are
 * read-only, and inline emphasis follows a simplified scanner rather than
 * full CommonMark flanking rules.
 */

export type MarkdownInline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "em"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "delete"; readonly children: readonly MarkdownInline[] }
  | {
      readonly type: "link";
      readonly children: readonly MarkdownInline[];
      readonly href: string;
      /** Only safe hrefs become anchors; the rest render as literal text. */
      readonly safe: boolean;
    }
  | { readonly type: "image"; readonly alt: string; readonly src: string }
  | { readonly type: "break" };

export interface MarkdownListItem {
  /** Present when the item begins with a GFM task marker. */
  readonly task?: { readonly checked: boolean };
  readonly children: readonly MarkdownBlock[];
}

export type MarkdownBlock =
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly type: "paragraph"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "code"; readonly text: string; readonly info: string }
  | { readonly type: "quote"; readonly children: readonly MarkdownBlock[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: readonly MarkdownListItem[];
    }
  | { readonly type: "rule" };

/**
 * Nesting past this depth stops recursing and degrades to literal text —
 * adversarial input like `[a](x [b](y …))` or `>>>>…` cannot overflow the
 * stack. Sixty-four levels is far beyond anything hand-written markdown
 * produces.
 */
const MAX_NESTING_DEPTH = 64;

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Which link destinations may become anchors. http(s), mailto and fragment
 * references only — every other scheme (`javascript:`, `data:`, `file:`, …)
 * and every relative/workspace path renders as text. Strict on purpose: the
 * view has no navigation contract, so a link it cannot open safely is text.
 */
export function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) return /^#[^\s<>]*$/.test(trimmed);
  return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(trimmed);
}

function runLength(text: string, at: number, ch: string): number {
  let end = at;
  while (end < text.length && text[end] === ch) end += 1;
  return end - at;
}

/** Index of the next `count`-long `ch` run, or -1. */
function findRun(text: string, from: number, ch: string, count: number): number {
  const needle = ch.repeat(count);
  let index = text.indexOf(needle, from);
  while (index !== -1) {
    if (runLength(text, index, ch) === count) return index;
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

/** `]` that closes the `[` at `at` (skips `\]` escapes, one level of `[`). */
function findCloseBracket(text: string, at: number): number {
  let depth = 0;
  for (let i = at + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * `)` that closes the `(` at `at`. Balanced inner parens and a `<…>` span
 * are tolerated so `a(b)c` and `<a b>` destinations still close.
 */
function findCloseParen(text: string, at: number): number {
  let depth = 0;
  let inAngles = false;
  for (let i = at + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inAngles) {
      if (ch === ">") inAngles = false;
      continue;
    }
    if (ch === "<") inAngles = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth -= 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The destination half of `(<inner>)`: a `<…>` destination or the first
 * whitespace-free token; an optional "title" after it is dropped.
 */
export function splitLinkTarget(inner: string): { readonly href: string } {
  const trimmed = inner.trim();
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close > 0) return { href: trimmed.slice(1, close) };
  }
  const space = trimmed.search(/[\t ]/);
  return { href: space === -1 ? trimmed : trimmed.slice(0, space) };
}

const AUTOLINK_URI = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/;
const AUTOLINK_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Inline markdown → inline nodes. Escape sequences, code spans, links,
 * images, autolinks, strong/em/del runs and hard breaks; unmatched markers
 * and raw HTML degrade to literal text — nothing is ever re-parsed as markup
 * the caller did not write as markdown.
 */
export function parseInlines(text: string, depth = 0): MarkdownInline[] {
  if (depth >= MAX_NESTING_DEPTH) return text === "" ? [] : [{ type: "text", text }];
  const nodes: MarkdownInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };
  const pushBreak = () => {
    buffer = buffer.replace(/[ \t]+$/, "");
    flush();
    nodes.push({ type: "break" });
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "\n") {
        pushBreak();
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      const run = runLength(text, i, "`");
      const closer = findRun(text, i + run, "`", run);
      if (closer !== -1) {
        flush();
        let code = text.slice(i + run, closer).replace(/\n/g, " ");
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code))
          code = code.slice(1, -1);
        nodes.push({ type: "code", text: code });
        i = closer + run;
        continue;
      }
      buffer += ch.repeat(run);
      i += run;
      continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      const close = findCloseBracket(text, i + 1);
      const end = close !== -1 && text[close + 1] === "(" ? findCloseParen(text, close + 1) : -1;
      if (end !== -1) {
        flush();
        nodes.push({
          type: "image",
          alt: text.slice(i + 2, close),
          src: splitLinkTarget(text.slice(close + 2, end)).href,
        });
        i = end + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = findCloseBracket(text, i);
      const end = close !== -1 && text[close + 1] === "(" ? findCloseParen(text, close + 1) : -1;
      if (end !== -1) {
        flush();
        const href = splitLinkTarget(text.slice(close + 2, end)).href;
        nodes.push({
          type: "link",
          children: parseInlines(text.slice(i + 1, close), depth + 1),
          href,
          safe: isSafeLinkHref(href),
        });
        i = end + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "<") {
      const end = text.indexOf(">", i + 1);
      if (end > i + 1) {
        const inner = text.slice(i + 1, end);
        if (AUTOLINK_URI.test(inner)) {
          flush();
          nodes.push({
            type: "link",
            children: [{ type: "text", text: inner }],
            href: inner,
            safe: isSafeLinkHref(inner),
          });
          i = end + 1;
          continue;
        }
        if (AUTOLINK_EMAIL.test(inner)) {
          flush();
          nodes.push({
            type: "link",
            children: [{ type: "text", text: inner }],
            href: `mailto:${inner}`,
            safe: true,
          });
          i = end + 1;
          continue;
        }
      }
      buffer += ch;
      i += 1;
      continue;
    }
    if (ch === "~" && text[i + 1] === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close > i + 2) {
        flush();
        nodes.push({
          type: "delete",
          children: parseInlines(text.slice(i + 2, close), depth + 1),
        });
        i = close + 2;
        continue;
      }
      buffer += "~~";
      i += 2;
      continue;
    }
    if (ch === "*" || ch === "_") {
      const run = runLength(text, i, ch);
      if (run >= 2) {
        const close = text.indexOf(ch + ch, i + 2);
        if (close > i + 2) {
          flush();
          nodes.push({
            type: "strong",
            children: parseInlines(text.slice(i + 2, close), depth + 1),
          });
          i = close + 2;
          continue;
        }
      }
      const close = text.indexOf(ch, i + 1);
      if (
        close > i + 1 &&
        !/\s/.test(text[i + 1]) &&
        !/\s/.test(text[close - 1]) &&
        // `_` does not open or close inside a word (approximate flanking).
        (ch === "*" || !(i > 0 && /\w/.test(text[i - 1])) || !/\w/.test(text[close + 1] ?? ""))
      ) {
        flush();
        nodes.push({ type: "em", children: parseInlines(text.slice(i + 1, close), depth + 1) });
        i = close + 1;
        continue;
      }
      buffer += ch.repeat(run);
      i += run;
      continue;
    }
    if (ch === "\n") {
      // Two+ trailing spaces make a hard break; a lone newline stays a
      // collapsible space (native renders files without remark-breaks).
      if (/ {2,}$/.test(buffer)) pushBreak();
      else buffer += " ";
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return nodes;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*$)/;
const SETEXT_RE = /^ {0,3}(=+|-+)[\t ]*$/;
const RULE_RE = /^ {0,3}((\*[\t ]*){3,}|(_[\t ]*){3,}|(-[\t ]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?/;
const LIST_RE = /^( {0,3})([-+*]|\d{1,9}[.)])([\t ]*)(.*)$/;
const TASK_RE = /^\[([ xX])\]([\t ]+|$)/;

function isRuleLine(line: string): boolean {
  const match = RULE_RE.exec(line);
  if (!match) return false;
  const chars = line.trim().replace(/[\t ]/g, "");
  return chars.length >= 3 && chars.split("").every((ch) => ch === chars[0]);
}

/** True when `line` opens a block that may interrupt a paragraph. */
function interruptsParagraph(line: string): boolean {
  if (FENCE_RE.test(line) || ATX_RE.test(line) || QUOTE_RE.test(line)) return true;
  if (isRuleLine(line)) return true;
  const list = LIST_RE.exec(line);
  // A list interrupts a paragraph only when its first item is non-empty.
  return list !== null && list[4].trim() !== "";
}

interface ParsedItem {
  readonly task?: { readonly checked: boolean };
  readonly children: readonly MarkdownBlock[];
}

/**
 * One list starting at lines[at] (already known to match LIST_RE). Sibling
 * items share the marker indent; deeper-indented lines are the current
 * item's continuation and are recursively parsed as blocks, which gives
 * nested lists and multi-paragraph items for free.
 */
function parseList(
  lines: readonly string[],
  at: number,
  depth: number,
): { readonly block: MarkdownBlock; readonly next: number } {
  const first = LIST_RE.exec(lines[at])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2][0]);
  // CommonMark: a bullet switch (`-` → `*`) or ordered-delimiter switch
  // (`1.` → `1)`) starts a new list.
  const delimiter = ordered ? first[2].slice(-1) : first[2];
  const items: { task?: { checked: boolean }; lines: string[] }[] = [];
  let i = at;
  while (i < lines.length) {
    const line = lines[i];
    const marker = LIST_RE.exec(line);
    if (marker !== null && marker[1].length === baseIndent) {
      const markerOrdered = /\d/.test(marker[2][0]);
      const markerDelimiter = markerOrdered ? marker[2].slice(-1) : marker[2];
      if (markerOrdered !== ordered || markerDelimiter !== delimiter) break;
      // Content indent: marker + 1–4 spaces; a wider gap collapses to one.
      const gap = Math.min(Math.max(marker[3].length, 1), 4);
      const contentIndent = baseIndent + marker[2].length + gap;
      let content = marker[4];
      let task: { checked: boolean } | undefined;
      const taskMarker = TASK_RE.exec(content);
      if (taskMarker !== null) {
        task = { checked: taskMarker[1] !== " " };
        content = content.slice(taskMarker[0].length);
      }
      items.push({ ...(task === undefined ? {} : { task }), lines: [content] });
      i += 1;
      // Continuation lines belong to this item until the next sibling
      // marker or a dedent; blanks are kept so inner blocks can separate.
      while (i < lines.length) {
        const next = lines[i];
        if (/^[\t ]*$/.test(next)) {
          // A blank continues the item only if a deeper-indented or
          // sibling-marker line follows; otherwise the list ends.
          let probe = i + 1;
          while (probe < lines.length && /^[\t ]*$/.test(lines[probe])) probe += 1;
          if (probe >= lines.length) {
            i = lines.length;
            break;
          }
          const probeMarker = LIST_RE.exec(lines[probe]);
          const probeIndent = lines[probe].length - lines[probe].trimStart().length;
          const continuesItem =
            (probeMarker !== null &&
              probeMarker[1].length === baseIndent &&
              /\d/.test(probeMarker[2][0]) === ordered &&
              (ordered ? probeMarker[2].slice(-1) : probeMarker[2]) === delimiter) ||
            probeIndent >= contentIndent;
          if (!continuesItem) {
            i = probe;
            break;
          }
          items[items.length - 1]!.lines.push("");
          i += 1;
          continue;
        }
        const nextMarker = LIST_RE.exec(next);
        if (
          nextMarker !== null &&
          nextMarker[1].length === baseIndent &&
          /\d/.test(nextMarker[2][0]) === ordered &&
          (ordered ? nextMarker[2].slice(-1) : nextMarker[2]) === delimiter
        )
          break;
        const indent = next.length - next.trimStart().length;
        if (indent >= contentIndent) {
          items[items.length - 1]!.lines.push(next.slice(contentIndent));
          i += 1;
          continue;
        }
        // Lazy continuation: a non-blank, non-block line still joins the
        // item's paragraph (CommonMark's laziness rule).
        if (!interruptsParagraph(next)) {
          items[items.length - 1]!.lines.push(next);
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  const parsed: ParsedItem[] = items.map((item) => ({
    ...(item.task === undefined ? {} : { task: item.task }),
    children: parseMarkdown(item.lines.join("\n"), depth + 1),
  }));
  return { block: { type: "list", ordered, items: parsed }, next: i };
}

/** The package-owned markdown block parser the preview renders. */
export function parseMarkdown(source: string, depth = 0): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (depth >= MAX_NESTING_DEPTH) {
    const rest = lines.join("\n").trim();
    return rest === "" ? [] : [{ type: "paragraph", children: [{ type: "text", text: rest }] }];
  }
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[\t ]*$/.test(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1][0];
      const needed = fence[1].length;
      const info = fence[2].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        if (new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${needed},}[\t ]*$`).test(lines[i])) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", text: body.join("\n"), info });
      continue;
    }
    const heading = ATX_RE.exec(line);
    if (heading !== null) {
      const text = (heading[2] ?? "").replace(/[\t ]+#+[\t ]*$/, "");
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInlines(text),
      });
      i += 1;
      continue;
    }
    if (isRuleLine(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        if (QUOTE_RE.test(lines[i])) {
          inner.push(lines[i].replace(QUOTE_RE, ""));
          i += 1;
          continue;
        }
        // Lazy continuation of a paragraph inside the quote.
        if (!/^[\t ]*$/.test(lines[i]) && !interruptsParagraph(lines[i])) {
          inner.push(lines[i]);
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "quote", children: parseMarkdown(inner.join("\n"), depth + 1) });
      continue;
    }
    if (LIST_RE.test(line) && LIST_RE.exec(line)![4].trim() !== "") {
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || /^[\t ]*$/.test(lines[i]))) {
        body.push(/^ {4}/.test(lines[i]) ? lines[i].slice(4) : "");
        i += 1;
      }
      while (body.length && body[body.length - 1] === "") body.pop();
      blocks.push({ type: "code", text: body.join("\n"), info: "" });
      continue;
    }
    // Paragraph: lines until a blank or an interrupting block; a trailing
    // `===`/`---` line promotes it to a setext heading.
    const body: string[] = [];
    while (i < lines.length && !/^[\t ]*$/.test(lines[i])) {
      const setext = body.length > 0 ? SETEXT_RE.exec(lines[i]) : null;
      if (setext !== null) {
        i += 1;
        blocks.push({
          type: "heading",
          level: setext[1][0] === "=" ? 1 : 2,
          children: parseInlines(body.join("\n")),
        });
        body.length = 0;
        break;
      }
      if (body.length > 0 && interruptsParagraph(lines[i])) break;
      body.push(lines[i]);
      i += 1;
    }
    if (body.length > 0)
      blocks.push({ type: "paragraph", children: parseInlines(body.join("\n")) });
  }
  return blocks;
}
