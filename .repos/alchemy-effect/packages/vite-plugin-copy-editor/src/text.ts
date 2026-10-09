/**
 * Format-agnostic text rewriting.
 *
 * An editable element renders as a sequence of DOM text nodes. The source
 * that produced it is described as a matching sequence of {@link Run}s
 * (source ranges between markup). An edit pairs each changed text node with
 * its run and rewrites only the words that changed, so markup, escapes, and
 * line wrapping outside the edited words are preserved verbatim.
 *
 * A {@link Dialect} supplies the source-format specifics: how a run splits
 * into words and whitespace, how words compare with rendered text, and how
 * new words are escaped.
 */

export class CopyEditError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** `text` is editable prose, `code` is literal (no escaping), `locked` can't be edited. */
export type RunKind = "text" | "code" | "locked";

export interface Run {
  start: number;
  end: number;
  kind?: RunKind;
  /** Rendered text of a `locked` run (its source is not literal text). */
  expected?: string;
  /** True when the run starts a source line (block syntax applies there). */
  lineStart?: boolean;
}

export interface TextToken {
  raw: string;
  ws: boolean;
  /** Rendered text of the token (whitespace tokens render as a space). */
  text: string;
}

export interface EscapeContext {
  kind: RunKind;
  /** True when the escaped word will begin a source line. */
  lineStart: boolean;
}

export interface Dialect {
  tokenize(raw: string, kind: RunKind): TextToken[];
  /** Canonical form used to compare source text with rendered text. */
  compare(text: string): string;
  /** Escapes a word typed in the browser for insertion into the source. */
  escape(word: string, context: EscapeContext): string;
}

export interface TextEdit {
  /** The element's DOM text nodes when editing started. */
  before: string[];
  /** The element's DOM text nodes after editing. */
  after: string[];
}

/** HTML whitespace (deliberately excludes the non-breaking space). */
export const WS = /[ \t\n\r\f]+/;

export const normalize = (text: string) =>
  text.split(WS).filter(Boolean).join(" ");

const runText = (code: string, run: Run, dialect: Dialect) =>
  dialect.compare(
    normalize(
      run.kind === "locked"
        ? (run.expected ?? "")
        : dialect
            .tokenize(code.slice(run.start, run.end), run.kind ?? "text")
            .map((t) => t.text)
            .join(""),
    ),
  );

/**
 * Rewrites one raw source run so it renders as `next`, touching only the
 * words that changed.
 */
const rewriteRun = (
  raw: string,
  next: string,
  dialect: Dialect,
  kind: RunKind,
  runLineStart: boolean,
): string => {
  const tokens = dialect.tokenize(raw, kind);
  const wordIdx = tokens.flatMap((t, i) => (t.ws ? [] : [i]));
  const oldWords = wordIdx.map((i) => dialect.compare(tokens[i].text));
  const typed = next.split(WS).filter(Boolean);
  const newWords = typed.map((w) => dialect.compare(w));

  const lineStartAt = (tokenIndex: number) =>
    tokenIndex === 0 ? runLineStart : tokens[tokenIndex - 1].raw.includes("\n");
  const render = (words: string[], lineStart: boolean) =>
    words
      .map((w, i) =>
        dialect.escape(w, { kind, lineStart: lineStart && i === 0 }),
      )
      .join(" ");

  if (oldWords.length === 0) {
    if (typed.length === 0) return raw;
    const lead = tokens[0]?.raw ?? "";
    const trail = tokens.length > 1 ? tokens[tokens.length - 1].raw : lead;
    return `${lead}${render(typed, runLineStart || lead.includes("\n"))}${trail}`;
  }

  let p = 0;
  const max = Math.min(oldWords.length, newWords.length);
  while (p < max && oldWords[p] === newWords[p]) p++;
  let s = 0;
  while (
    s < max - p &&
    oldWords[oldWords.length - 1 - s] === newWords[newWords.length - 1 - s]
  )
    s++;

  const middleWords = typed.slice(p, typed.length - s);
  const oldCount = oldWords.length - s - p;
  const raws = tokens.map((t) => t.raw);

  if (oldCount > 0) {
    let from = wordIdx[p];
    let to = wordIdx[oldWords.length - s - 1];
    const middle = render(middleWords, lineStartAt(from));
    if (!middle) {
      // Drop one whitespace neighbour so the surrounding words don't collide.
      if (p > 0) from = wordIdx[p - 1] + 1;
      else if (s > 0) to = wordIdx[oldWords.length - s] - 1;
    }
    raws.splice(from, to - from + 1, middle);
  } else if (middleWords.length > 0) {
    if (p > 0) {
      raws.splice(wordIdx[p - 1] + 1, 0, ` ${render(middleWords, false)}`);
    } else {
      raws.splice(
        wordIdx[0],
        0,
        `${render(middleWords, lineStartAt(wordIdx[0]))} `,
      );
    }
  }
  return raws.join("");
};

/**
 * Applies a browser edit to `code`, given the source runs that produced the
 * edited element's text nodes. Returns the new source.
 */
export const applyRuns = (
  code: string,
  runs: Run[],
  dialect: Dialect,
  { before, after }: TextEdit,
): string => {
  if (before.length !== after.length) {
    throw new CopyEditError(
      "The edit removed or added markup (for example, deleted a whole <code>). Edit within text runs, or change the markup in code.",
    );
  }
  const texts = runs.map((run) => runText(code, run, dialect));
  const rendered = (t: string) => dialect.compare(normalize(t));

  // Pair DOM text nodes with source runs: one-to-one when the counts agree,
  // otherwise (renderers drop empty and whitespace-only runs) only the
  // non-blank ones. The first pairing whose texts all match wins.
  type Pairs = [run: number, node: number][];
  const candidates: Pairs[] = [];
  if (runs.length === before.length)
    candidates.push(runs.map((_, i) => [i, i]));
  const runIdx = texts.flatMap((t, i) => (t === "" ? [] : [i]));
  const domIdx = before.flatMap((t, i) => (normalize(t) === "" ? [] : [i]));
  if (runIdx.length === domIdx.length) {
    candidates.push(runIdx.map((r, i) => [r, domIdx[i]]));
  }
  const pairs = candidates.find((c) =>
    c.every(([r, d]) => texts[r] === rendered(before[d])),
  );
  if (!pairs) throw stale();
  const paired = new Set(pairs.map(([, d]) => d));
  if (
    before.some((t, d) => !paired.has(d) && rendered(t) !== rendered(after[d]))
  ) {
    throw new CopyEditError(
      "That spot (between two pieces of markup) has no text in the source. Type inside an existing word run instead.",
    );
  }

  let out = code;
  // Apply from the end so earlier offsets stay valid.
  for (const [r, d] of [...pairs].reverse()) {
    if (rendered(after[d]) === rendered(before[d])) continue;
    const run = runs[r];
    if (run.kind === "locked") {
      throw new CopyEditError(
        `"${normalize(before[d])}" is generated (for example, a link to another page) and can't be edited here. Change it in the source.`,
      );
    }
    out =
      out.slice(0, run.start) +
      rewriteRun(
        out.slice(run.start, run.end),
        after[d],
        dialect,
        run.kind ?? "text",
        run.lineStart ?? false,
      ) +
      out.slice(run.end);
  }
  return out;
};

export const stale = () =>
  new CopyEditError(
    "The text on the page doesn't match the source (the file changed, or a script rewrote this element). Reload and try again.",
    409,
  );

// ── HTML templates (.astro, .html, JSX, Vue, Svelte) ──────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  mdash: "—",
  ndash: "–",
  rarr: "→",
  larr: "←",
  hellip: "…",
  middot: "·",
  copy: "©",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  bull: "•",
};

export const decodeEntities = (raw: string): string =>
  raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });

/** Text between tags in HTML-like templates; `{" "}` counts as whitespace. */
export const htmlDialect: Dialect = {
  tokenize(raw) {
    const tokens: TextToken[] = [];
    const re =
      /(\{\s*(?:"\s+"|'\s+')\s*\})|([ \t\n\r\f]+)|([^ \t\n\r\f{]+)|(\{)/g;
    for (const m of raw.matchAll(re)) {
      if (m[4]) {
        throw new CopyEditError(
          "Editable copy can't contain {expressions}. Move data-copy to a plain-text element.",
        );
      }
      const ws = Boolean(m[1] || m[2]);
      tokens.push({ raw: m[0], ws, text: ws ? " " : decodeEntities(m[0]) });
    }
    return tokens;
  },
  compare: (text) => text,
  escape: (word) =>
    word
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\{/g, "&#123;")
      .replace(/\}/g, "&#125;")
      .replace(/\u00a0/g, "&nbsp;"),
};
