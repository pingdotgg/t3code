/**
 * Source rewriting for the dev-only copy editor.
 *
 * Elements marked with a bare `data-copy` attribute in HTML-like templates
 * (`.astro`, `.html`, JSX, Vue, Svelte) are editable in dev. This module locates those elements in the raw
 * source, stamps them with their location (dev), strips the attribute
 * (build), and writes edited text back into the source.
 *
 * Only the text between tags is ever rewritten; tags, attributes, and
 * unchanged words (including their line wrapping) are preserved verbatim.
 */

import { marked } from "marked";
import {
  applyRuns,
  CopyEditError,
  decodeEntities,
  htmlDialect,
  type Run,
  type TextEdit,
} from "./text.ts";

export const ATTR = "data-copy";

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

interface Attr {
  name: string;
  /** Start of the attribute name. */
  start: number;
  /** End of the attribute (after its value, if any). */
  end: number;
}

type Token =
  | {
      kind: "open";
      name: string;
      start: number;
      end: number;
      selfClosing: boolean;
      attrs: Attr[];
    }
  | { kind: "close"; name: string; start: number; end: number }
  | { kind: "comment"; start: number; end: number };

const frontmatterEnd = (code: string): number => {
  const match = /^\s*---\r?\n[\s\S]*?\r?\n---[^\n]*\n?/.exec(code);
  return match ? match[0].length : 0;
};

/** Skips a balanced `{...}` expression starting at `i` (which must be `{`). */
const skipBraces = (code: string, i: number): number => {
  let depth = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
};

const skipString = (code: string, i: number): number => {
  const quote = code[i];
  i++;
  while (i < code.length && code[i] !== quote) {
    if (code[i] === "\\") i++;
    i++;
  }
  return i + 1;
};

const NAME_START = /[A-Za-z]/;

const parseOpenTag = (
  code: string,
  start: number,
): Token & { kind: "open" } => {
  let i = start + 1;
  const nameMatch = /^[A-Za-z][\w:.-]*/.exec(code.slice(i, i + 200));
  const name = nameMatch ? nameMatch[0] : "";
  i += name.length;
  const attrs: Attr[] = [];
  while (i < code.length) {
    const ch = code[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === ">") {
      return {
        kind: "open",
        name,
        start,
        end: i + 1,
        selfClosing: false,
        attrs,
      };
    } else if (ch === "/" && code[i + 1] === ">") {
      return {
        kind: "open",
        name,
        start,
        end: i + 2,
        selfClosing: true,
        attrs,
      };
    } else if (ch === "{") {
      i = skipBraces(code, i);
    } else {
      const attrStart = i;
      while (
        i < code.length &&
        !/[\s=>{]/.test(code[i]) &&
        !(code[i] === "/" && code[i + 1] === ">")
      ) {
        i++;
      }
      const attrName = code.slice(attrStart, i);
      let j = i;
      while (/\s/.test(code[j] ?? "")) j++;
      if (code[j] === "=") {
        j++;
        while (/\s/.test(code[j] ?? "")) j++;
        const q = code[j];
        if (q === '"' || q === "'" || q === "`") j = skipString(code, j);
        else if (q === "{") j = skipBraces(code, j);
        else while (j < code.length && !/[\s>]/.test(code[j])) j++;
        i = j;
      }
      attrs.push({ name: attrName, start: attrStart, end: i });
      if (i === attrStart) i++;
    }
  }
  return {
    kind: "open",
    name,
    start,
    end: code.length,
    selfClosing: true,
    attrs,
  };
};

/** Tokenizes the template part of an `.astro` file into tags and comments. */
const tokenize = (code: string): Token[] => {
  const tokens: Token[] = [];
  let i = frontmatterEnd(code);
  while (i < code.length) {
    if (code[i] !== "<") {
      i++;
      continue;
    }
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i);
      const stop = end === -1 ? code.length : end + 3;
      tokens.push({ kind: "comment", start: i, end: stop });
      i = stop;
      continue;
    }
    const next = code[i + 1] ?? "";
    if (next === "/") {
      const m = /^<\/([A-Za-z][\w:.-]*)?\s*>/.exec(code.slice(i, i + 200));
      if (m) {
        tokens.push({
          kind: "close",
          name: m[1] ?? "",
          start: i,
          end: i + m[0].length,
        });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (next === ">" || NAME_START.test(next)) {
      const tag = parseOpenTag(code, i);
      if (VOID_ELEMENTS.has(tag.name.toLowerCase())) tag.selfClosing = true;
      tokens.push(tag);
      i = tag.end;
      const raw = tag.name.toLowerCase();
      if (!tag.selfClosing && (raw === "script" || raw === "style")) {
        const close = code.toLowerCase().indexOf(`</${raw}`, i);
        i = close === -1 ? code.length : close;
      }
      continue;
    }
    i++;
  }
  return tokens;
};

const copyTags = (tokens: Token[]) =>
  tokens.flatMap((token, index) => {
    if (token.kind !== "open") return [];
    const attr = token.attrs.find((a) => a.name === ATTR);
    return attr ? [{ token, index, attr }] : [];
  });

/**
 * Replaces each `data-copy` attribute with `data-copy="<file>#<n>"`, plus
 * `data-copy-format="inline"` when the element's content can round-trip
 * through inline markdown (text, `code`, `strong`, `em`, `del`, `a`).
 */
export const annotate = (code: string, file: string): string => {
  if (!code.includes(ATTR)) return code;
  const tags = copyTags(tokenize(code));
  let out = code;
  for (let n = tags.length - 1; n >= 0; n--) {
    const { attr } = tags[n];
    let inline = true;
    try {
      inlineSource(code, n);
    } catch {
      inline = false;
    }
    const format = inline ? ` ${ATTR}-format="inline"` : "";
    out = `${out.slice(0, attr.start)}${ATTR}="${file}#${n}"${format}${out.slice(attr.end)}`;
  }
  return out;
};

/** Removes every `data-copy` attribute (and the whitespace before it). */
export const strip = (code: string): string => {
  if (!code.includes(ATTR)) return code;
  const tags = copyTags(tokenize(code));
  let out = code;
  for (let n = tags.length - 1; n >= 0; n--) {
    const { attr } = tags[n];
    let start = attr.start;
    while (start > 0 && /\s/.test(out[start - 1])) start--;
    out = out.slice(0, start) + out.slice(attr.end);
  }
  return out;
};

/** The `n`-th `data-copy` element: its open tag and the tokens inside it. */
const elementOf = (code: string, n: number) => {
  const tokens = tokenize(code);
  const tags = copyTags(tokens);
  const target = tags[n];
  if (!target) {
    throw new CopyEditError(
      `No data-copy element #${n} in this file. Reload the page.`,
      409,
    );
  }
  const { token: open, index } = target;
  if (open.selfClosing)
    throw new CopyEditError("data-copy is on an empty element.");
  let depth = 1;
  let closeIndex = -1;
  for (let k = index + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "open" && t.name === open.name && !t.selfClosing) depth++;
    if (t.kind === "close" && t.name === open.name && --depth === 0) {
      closeIndex = k;
      break;
    }
  }
  if (closeIndex === -1)
    throw new CopyEditError(`No closing </${open.name}> found.`);
  return {
    open,
    inner: tokens.slice(index + 1, closeIndex),
    close: tokens[closeIndex] as Token & { kind: "close" },
  };
};

/** The text runs between tags inside the `n`-th `data-copy` element. */
const segmentsOf = (code: string, n: number): Run[] => {
  const { open, inner, close } = elementOf(code, n);
  const segments: Run[] = [];
  let cursor = open.end;
  for (const t of [...inner, close]) {
    if (t.kind === "comment")
      throw new CopyEditError("Editable copy can't contain HTML comments.");
    if ((t.kind === "open" || t.kind === "close") && /^[A-Z]/.test(t.name)) {
      throw new CopyEditError(
        `Editable copy can't contain components (<${t.name}>).`,
      );
    }
    if (t.kind === "open" && /^(script|style)$/i.test(t.name)) {
      throw new CopyEditError(
        "Editable copy can't contain <script> or <style>.",
      );
    }
    segments.push({ start: cursor, end: t.start });
    cursor = t.end;
  }
  return segments;
};

export interface EditRequest extends TextEdit {
  /** Index of the `data-copy` element within the file. */
  index: number;
}

/** Applies an edit to an HTML-like template and returns the new source. */
export const applyEdit = (
  code: string,
  { index, before, after }: EditRequest,
): string =>
  applyRuns(code, segmentsOf(code, index), htmlDialect, { before, after });

// ── inline markdown ───────────────────────────────────────────────────────

const INLINE_TAGS: Record<string, [open: string, close: string]> = {
  code: ["`", "`"],
  strong: ["**", "**"],
  b: ["**", "**"],
  em: ["*", "*"],
  i: ["*", "*"],
  del: ["~~", "~~"],
  s: ["~~", "~~"],
  a: ["[", "]"],
};
/** The tag inline markdown produces for each markdown construct. */
const MARKDOWN_TAG: Record<string, string> = {
  b: "strong",
  i: "em",
  s: "del",
};

const escapeMarkdown = (text: string) =>
  text
    .replace(/[\\`*[\]<]/g, "\\$&")
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_"))
    .replace(/~~/g, "\\~\\~");

const hrefOf = (code: string, attrs: Attr[]) => {
  const attr = attrs.find((a) => a.name === "href");
  if (!attr) return undefined;
  const m = /^href\s*=\s*(["'])([^"'{}]*)\1$/.exec(
    code.slice(attr.start, attr.end),
  );
  if (!m)
    throw new CopyEditError("Links need a literal href to edit as markdown.");
  return decodeEntities(m[2]!);
};

/**
 * The `n`-th `data-copy` element's content as inline markdown, plus what's
 * needed to write markdown back: the content's source range and the
 * attributes each tag carries in the source.
 */
export const inlineSource = (code: string, n: number) => {
  const { open, inner, close } = elementOf(code, n);
  const templates: Record<string, string> = {};
  const links: string[] = [];
  let md = "";
  let inCode = false;
  let skipSpace = false;
  let cursor = open.end;
  const text = (raw: string) => {
    const words = htmlDialect
      .tokenize(raw, "text")
      .map((t) => t.text)
      .join("");
    let collapsed = words.replace(/\s+/g, " ");
    if (skipSpace) collapsed = collapsed.replace(/^ /, "");
    if (collapsed) skipSpace = false;
    md += inCode ? collapsed : escapeMarkdown(collapsed);
  };
  for (const t of inner) {
    text(code.slice(cursor, t.start));
    cursor = t.end;
    if (t.kind === "comment")
      throw new CopyEditError("HTML comments can't be edited as markdown.");
    const name = t.name.toLowerCase();
    if (name === "br" && t.kind === "open" && !inCode) {
      // A line break: the whitespace around it isn't content.
      md = `${md.replace(/ +$/, "")}\n`;
      skipSpace = true;
      continue;
    }
    const syntax = INLINE_TAGS[name];
    if (!syntax || (inCode && t.kind === "open")) {
      throw new CopyEditError(`<${t.name}> can't be edited as markdown.`);
    }
    if (t.kind === "open") {
      if (t.selfClosing)
        throw new CopyEditError(`<${t.name}/> can't be edited as markdown.`);
      const tag = MARKDOWN_TAG[name] ?? name;
      if (!(tag in templates)) {
        const attrs = t.attrs
          .filter((a) => a.name !== "href")
          .map((a) => code.slice(a.start, a.end))
          .join(" ");
        templates[tag] = attrs ? ` ${attrs}` : "";
      }
      if (name === "a") links.push(hrefOf(code, t.attrs) ?? "");
      if (name === "code") inCode = true;
      md += syntax[0];
    } else {
      if (name === "code") inCode = false;
      md += name === "a" ? `](${links.pop() ?? ""})` : syntax[1];
    }
  }
  text(code.slice(cursor, close.start));
  const raw = code.slice(open.end, close.start);
  return {
    markdown: md.trim(),
    start: open.end,
    end: close.start,
    lead: /^\s*/.exec(raw)![0],
    trail: /\s*$/.exec(raw)![0],
    templates,
  };
};

/** Inline markdown as template HTML, reusing each tag's source attributes. */
export const inlineHtml = (
  markdown: string,
  templates: Record<string, string>,
) => {
  // Each line break in the markdown becomes a <br>.
  const html = marked.parseInline(markdown.replace(/[ \t]*\n\s*/g, "\n"), {
    async: false,
    gfm: true,
    breaks: true,
  });
  return html
    .split(/(<[^>]+>)/)
    .map((part, i) => {
      if (i % 2 === 0) {
        return part
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\{/g, "&#123;")
          .replace(/\}/g, "&#125;");
      }
      const tag = /^<\/?([a-z]+)(\s[^>]*)?>$/.exec(part);
      if (!tag || !(tag[1]! in INLINE_TAGS || tag[1] === "br")) {
        // Typed HTML that isn't an inline markdown construct stays text.
        return part.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      if (part.startsWith("</")) return part;
      const [, name, attrs = ""] = tag;
      if (!(name! in templates)) return part.replace(/[{}]/g, "");
      const href = /\shref="[^"]*"/.exec(attrs)?.[0] ?? "";
      return `<${name}${href}${templates[name!]}>`;
    })
    .join("");
};

/** Replaces the `n`-th element's content with `markdown` rendered as HTML. */
export const writeInline = (
  code: string,
  n: number,
  { markdown, base }: { markdown: string; base: string },
): string => {
  const current = inlineSource(code, n);
  if (current.markdown !== base.trim()) {
    throw new CopyEditError(
      "This copy changed since you started editing. Copy your text, reload, and try again.",
      409,
    );
  }
  if (markdown.trim() === current.markdown) return code;
  const html = inlineHtml(markdown.trim(), current.templates);
  return (
    code.slice(0, current.start) +
    current.lead +
    html +
    current.trail +
    code.slice(current.end)
  );
};
