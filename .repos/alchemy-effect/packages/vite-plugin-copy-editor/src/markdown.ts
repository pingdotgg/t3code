/**
 * Markdown prose as an editable source.
 *
 * {@link markdownRuns} splits one block of inline markdown (a paragraph,
 * heading, or list item) into the runs its rendered text nodes come from:
 * text between emphasis delimiters, code spans, link text, and so on. The
 * markdown can live inside another file (a JSDoc comment, a string) — the
 * `linePrefix` option describes text that starts each continuation line.
 */
import {
  CopyEditError,
  decodeEntities,
  type Dialect,
  type Run,
  type TextToken,
} from "./text.ts";

/** A syntax whose rendered text isn't literal source text (e.g. `{@link X}`). */
export interface Atomic {
  /** Matched at the current position (compiled with the sticky flag). */
  pattern: RegExp;
  /** The rendered text for a match (continuation-line prefixes removed). */
  text: (match: RegExpExecArray) => string;
}

export interface MarkdownOptions {
  /**
   * Source of a regex matching what follows `\n` on continuation lines and
   * isn't content, e.g. `"[ \\t]*\\*(?!/)[ \\t]?"` for JSDoc's ` * `.
   */
  linePrefix?: string;
  /** Extra inline syntaxes rendered as generated, non-editable text. */
  atomics?: Atomic[];
}

const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const isWs = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isPunct = (ch: string | undefined) => ch !== undefined && PUNCT.test(ch);

/** Straight quotes, dashes, and dots: how smart punctuation renders them. */
const canon = (text: string) =>
  text
    .replace(/[“”„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/—/g, "---")
    .replace(/–/g, "--")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ");

const decodeMarkdown = (raw: string) =>
  decodeEntities(raw.replace(/\\([!-/:-@[-`{-~])/g, "$1"));

export const markdownDialect = (options: MarkdownOptions = {}): Dialect => {
  const ws = new RegExp(
    `(?:[ \\t\\r\\f]|\\n${options.linePrefix ? `(?:${options.linePrefix})?` : ""})+`,
    "y",
  );
  return {
    tokenize(raw, kind) {
      const tokens: TextToken[] = [];
      let i = 0;
      while (i < raw.length) {
        ws.lastIndex = i;
        const m = ws.exec(raw);
        if (m && m[0].length > 0) {
          tokens.push({ raw: m[0], ws: true, text: " " });
          i += m[0].length;
          continue;
        }
        let j = i;
        while (j < raw.length && !/[ \t\r\f\n]/.test(raw[j])) j++;
        const word = raw.slice(i, j);
        tokens.push({
          raw: word,
          ws: false,
          text: kind === "code" ? word : decodeMarkdown(word),
        });
        i = j;
      }
      return tokens;
    },
    compare: canon,
    escape(word, { kind, lineStart }) {
      if (kind === "code") {
        if (word.includes("`") || word.includes("*/")) {
          throw new CopyEditError("Code spans can't contain ` or */.");
        }
        return word;
      }
      let out = word
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/…/g, "...")
        .replace(/[\\`*[\]<]/g, "\\$&")
        .replace(/^_|_$/g, "\\_")
        .replace(/~~/g, "\\~\\~")
        .replace(/\{@/g, "{\\@");
      if (lineStart) {
        out = out
          .replace(/^[#>+\-=|:@]/, "\\$&")
          .replace(/^(\d+)([.)])/, "$1\\$2");
      }
      // Never let prose close a surrounding block comment.
      return out.replace(/\*\//g, "*\\/");
    },
  };
};

/**
 * Splits the inline markdown in `code[start, end)` into runs matching its
 * rendered text nodes. The first run starts a line.
 */
export const markdownRuns = (
  code: string,
  start: number,
  end: number,
  options: MarkdownOptions = {},
): Run[] => {
  const prefix = options.linePrefix
    ? new RegExp(`\\n(?:${options.linePrefix})`, "g")
    : undefined;
  const clean = (raw: string) => (prefix ? raw.replace(prefix, "\n") : raw);
  const atomics = (options.atomics ?? []).map(({ pattern, text }) => ({
    pattern: new RegExp(
      pattern.source,
      `${pattern.flags.replace(/[gy]/g, "")}y`,
    ),
    text,
  }));

  const runs: Run[] = [];
  let runStart = start;
  const boundary = (at: number, resume: number) => {
    runs.push({ start: runStart, end: at, lineStart: runs.length === 0 });
    runStart = resume;
  };
  const locked = (at: number, resume: number, expected: string) => {
    boundary(at, at);
    runs.push({ start: at, end: resume, kind: "locked", expected });
    runStart = resume;
  };
  // Positions of `]` that close link text, mapped to the end of `](...)`.
  const linkEnds = new Map<number, number>();

  let i = start;
  while (i < end) {
    const ch = code[i];

    if (ch === "\\" && i + 1 < end && /[!-/:-@[-`{-~]/.test(code[i + 1])) {
      i += 2;
      continue;
    }

    const atomic = atomics.find((a) => {
      a.pattern.lastIndex = i;
      return a.pattern.test(code) && a.pattern.lastIndex <= end;
    });
    if (atomic) {
      atomic.pattern.lastIndex = i;
      const m = atomic.pattern.exec(code)!;
      const cleaned = Object.assign(m.map(clean), {
        index: m.index,
        input: m.input,
      });
      locked(i, i + m[0].length, atomic.text(cleaned as RegExpExecArray));
      i += m[0].length;
      continue;
    }

    if (ch === "`") {
      let n = 1;
      while (code[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let close = code.indexOf(fence, i + n);
      while (close !== -1 && close < end && code[close + n] === "`") {
        close = code.indexOf(fence, close + n + 1);
      }
      if (close !== -1 && close + n <= end) {
        boundary(i, i + n);
        runs.push({ start: i + n, end: close, kind: "code" });
        runStart = close + n;
        i = close + n;
        continue;
      }
      i += n;
      continue;
    }

    if (ch === "<") {
      const autolink = /^<(https?:\/\/[^\s<>]+)>/.exec(code.slice(i, end));
      if (autolink) {
        locked(i, i + autolink[0].length, autolink[1]);
        i += autolink[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][^<>]*>|^<!--[\s\S]*?-->/.exec(
        code.slice(i, end),
      );
      if (tag) {
        boundary(i, i + tag[0].length);
        i += tag[0].length;
        continue;
      }
    }

    if (
      ((ch === "h" || ch === "w") && isWs(code[i - 1])) ||
      (i === start && (ch === "h" || ch === "w"))
    ) {
      const url = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/.exec(
        code.slice(i, end),
      );
      if (url) {
        locked(i, i + url[0].length, url[0]);
        i += url[0].length;
        continue;
      }
    }

    if (ch === "!" && code[i + 1] === "[") {
      const img = /^!\[[^\]]*\]\([^)]*\)/.exec(code.slice(i, end));
      if (img) {
        boundary(i, i + img[0].length);
        i += img[0].length;
        continue;
      }
    }

    if (ch === "[") {
      const close = matchLink(code, i, end);
      if (close) {
        linkEnds.set(close.bracket, close.end);
        boundary(i, i + 1);
        i += 1;
        continue;
      }
    }
    if (ch === "]" && linkEnds.has(i)) {
      const after = linkEnds.get(i)!;
      boundary(i, after);
      i = after;
      continue;
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      let n = 1;
      while (code[i + n] === ch) n++;
      const prev = code[i - 1];
      const next = code[i + n];
      const left =
        !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const right =
        !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      const delimiter =
        ch === "~"
          ? n === 2 && (left || right)
          : ch === "*"
            ? left || right
            : (left && (!right || isPunct(prev))) ||
              (right && (!left || isPunct(next)));
      if (delimiter) {
        boundary(i, i + n);
        i += n;
        continue;
      }
      i += n;
      continue;
    }

    i++;
  }
  boundary(end, end);
  return runs;
};

/** Finds the `]` closing `[` at `open` when followed by `(destination)`. */
const matchLink = (code: string, open: number, end: number) => {
  let depth = 0;
  for (let i = open; i < end; i++) {
    const ch = code[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      const close = code.indexOf("`", i + 1);
      if (close === -1 || close >= end) return undefined;
      i = close;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      if (code[i + 1] !== "(") return undefined;
      let parens = 0;
      for (let j = i + 1; j < end; j++) {
        if (code[j] === "(") parens++;
        else if (code[j] === ")" && --parens === 0) {
          return { bracket: i, end: j + 1 };
        }
      }
      return undefined;
    }
  }
  return undefined;
};
