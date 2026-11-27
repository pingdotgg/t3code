import type { Node, RootContent, Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { markdownMathRanges, mayContainMath, parseMarkdownWithMath } from "./markdownMath.ts";
import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from "./markdownLinks.ts";
import { fileBasename } from "./path.ts";

const parser = unified().use(remarkParse).use(remarkGfm);

// Already ends a sentence, allowing closing quotes or brackets after the punctuation.
const SENTENCE_END = /[.!?…:;。！？：；]["'”’)\]]*$/u;
const SPACE = /\s/;
const PAUSE = /[,.;:!?…]/;

/** Marks a spoken character that the markdown does not contain, such as an added full stop. */
const ADDED = -1;

/** A spoken block: its range in the spoken text and the markdown range it was read from. */
export interface ReadAloudBlock {
  readonly spokenStart: number;
  readonly spokenEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface ReadAloudSpeech {
  readonly text: string;
  /** The markdown offset of each UTF-16 unit of `text`, or -1 for punctuation added for speech. */
  readonly sources: ReadonlyArray<number>;
  readonly blocks: ReadonlyArray<ReadAloudBlock>;
  /** Markdown ranges of formulas read as words; renderers show them as math, not as text. */
  readonly formulas: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

type Run = { text: string; sources: number[] };
type Positioned = Pick<Node, "position">;

const added = (text: string): Run => ({ text, sources: Array.from(text, () => ADDED) });

function concat(runs: ReadonlyArray<Run>): Run {
  return {
    text: runs.map((run) => run.text).join(""),
    sources: runs.flatMap((run) => run.sources),
  };
}

function trim(run: Run): Run {
  let start = 0;
  let end = run.text.length;
  while (start < end && SPACE.test(run.text.charAt(start))) start++;
  while (end > start && SPACE.test(run.text.charAt(end - 1))) end--;
  return { text: run.text.slice(start, end), sources: run.sources.slice(start, end) };
}

/** Words said for a node shown some other way, such as a formula, spread over its source. */
function spread(value: string, node: Positioned): Run {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return added(value);
  const span = Math.max(end - start, 1);
  return {
    text: value,
    sources: Array.from(
      { length: value.length },
      (_, index) => start + Math.floor((index * span) / Math.max(value.length, 1)),
    ),
  };
}

/** A node's text with the markdown offset of each character. */
function located(markdown: string, value: string, node: Positioned): Run {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return added(value);
  const at = markdown.slice(start, end) === value ? start : markdown.indexOf(value, start);
  if (at !== -1 && at + value.length <= end)
    return { text: value, sources: Array.from({ length: value.length }, (_, index) => at + index) };
  // Escapes and entities change the text, so its characters spread over the node's source.
  const span = Math.max(end - start, 1);
  return {
    text: value,
    sources: Array.from(
      { length: value.length },
      (_, index) => start + Math.floor((index * span) / value.length),
    ),
  };
}

/** Words for a TeX formula, or undefined to read its source. */
export type SpeakMath = (tex: string) => string | undefined;

/** The KaTeX renderer, passed in so only clients that speak formulas load it. */
export interface KatexRenderer {
  readonly renderToString: (
    tex: string,
    options: { output: "mathml"; displayMode: boolean; throwOnError: boolean },
  ) => string;
}

/**
 * Words for a TeX formula, as Speech Rule Engine's `toSpeech` says the MathML KaTeX renders for
 * it, or undefined when KaTeX cannot parse it.
 */
export function speakTex(
  katex: KatexRenderer,
  toSpeech: (mathml: string) => string,
  tex: string,
  display: boolean,
) {
  try {
    const markup = katex.renderToString(tex, {
      output: "mathml",
      displayMode: display,
      throwOnError: true,
    });
    const math = /<math[\s\S]*<\/math>/.exec(markup)?.[0];
    // The annotation repeats the TeX source, which would be read too.
    return math ? toSpeech(math.replace(/<annotation[\s\S]*?<\/annotation>/, "")) : undefined;
  } catch {
    return undefined;
  }
}

/** Words for an emoji, or undefined to leave it to the voice. */
export type SpeakEmoji = (emoji: string) => string | undefined;

/** Words for what a reply shows as something other than text. */
export interface ReadAloudWords {
  readonly math?: SpeakMath | undefined;
  readonly emoji?: SpeakEmoji | undefined;
}

const EMOJI =
  /\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)*/gu;

/** Says each match of `pattern` that `wordsFor` has words for, spread over the match's source. */
function sayAs(run: Run, pattern: RegExp, wordsFor: (match: string) => string | undefined): Run {
  const parts: Run[] = [];
  let from = 0;
  for (const match of run.text.matchAll(pattern)) {
    const said = wordsFor(match[0]);
    if (!said) continue;
    const words = ` ${said} `;
    const sources = run.sources.slice(match.index, match.index + match[0].length);
    parts.push(
      { text: run.text.slice(from, match.index), sources: run.sources.slice(from, match.index) },
      {
        text: words,
        sources: Array.from(
          words,
          (_, index) => sources[Math.floor((index * sources.length) / words.length)] ?? ADDED,
        ),
      },
    );
    from = match.index + match[0].length;
  }
  if (!parts.length) return run;
  parts.push({ text: run.text.slice(from), sources: run.sources.slice(from) });
  return concat(parts);
}

// Apple's names for the key symbols in shortcuts such as ⌘K or ⌥⇧↓.
const KEY_NAMES: Record<string, string> = {
  "⌘": "Command",
  "⌥": "Option",
  "⇧": "Shift",
  "⌃": "Control",
  "⎋": "Escape",
  "⏎": "Return",
  "↵": "Return",
  "⌫": "Delete",
  "⌦": "Forward Delete",
  "⇥": "Tab",
  "↑": "Up",
  "↓": "Down",
  "←": "Left",
  "→": "Right",
};
// An arrow is a key only after a modifier; elsewhere, as in "a → b", the voice reads it.
const KEYS = /[⌘⌥⇧⌃]+[↑↓←→]?|[⎋⏎↵⌫⌦⇥]/gu;
const sayKeys = (keys: string) => Array.from(keys, (key) => KEY_NAMES[key]).join(" ");

/** What a file chip shows, as words: its file name and lines. */
function spokenFile(href: string) {
  const file = parseMarkdownFileLink(href);
  if (!file) return undefined;
  const name = fileBasename(file.path).normalize("NFC");
  if (file.line === undefined) return name;
  return file.endLine === undefined
    ? `${name} line ${file.line}`
    : `${name} lines ${file.line} to ${file.endLine}`;
}

const WEB_URL = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)(?::\d+)?([^?#]*)([?#].*)?$/i;
// A host and one short path segment, such as `t3.codes/docs`, is read whole.
const SHORT_URL = 32;

/** A bare web address as words: a place on a code host, a short address, or else its host. */
function spokenUrl(href: string) {
  const match = WEB_URL.exec(href);
  if (!match?.[1]) return href;
  const host = match[1].toLowerCase().replace(/^www\./, "");
  const path = (match[2] ?? "").split("/").filter(Boolean);
  const short = [host, ...path].join("/");
  return (
    sourceControlPlace(host, path) ??
    (!match[3] && path.length <= 1 && short.length <= SHORT_URL ? short : host)
  );
}

function sourceControlPlace(host: string, path: ReadonlyArray<string>) {
  const site = host === "github.com" ? "GitHub" : host === "gitlab.com" ? "GitLab" : undefined;
  if (!site || path.length === 0) return undefined;
  // GitLab nests groups, and puts `-` between a project and its pages.
  const dash = site === "GitLab" ? path.indexOf("-") : -1;
  const project = dash > 0 ? path.slice(0, dash) : site === "GitLab" ? path : path.slice(0, 2);
  const [kind, id, ...rest] = dash > 0 ? path.slice(dash + 1) : path.slice(project.length);
  const repo = project.at(-1);
  if (kind === "pull" && id) return `${repo} pull request ${id}`;
  if (kind === "merge_requests" && id) return `${repo} merge request ${id}`;
  if (kind === "issues" && id) return `${repo} issue ${id}`;
  if (kind === "commit" && id) return `${repo} commit ${id.slice(0, 7)}`;
  if (kind === "blob" && rest.length) return `${rest.at(-1)} in ${repo}`;
  return `${repo} on ${site}`;
}

const nodeText = (node: RootContent): string =>
  "children" in node ? node.children.map(nodeText).join("") : "value" in node ? node.value : "";

/**
 * Plain text with one sentence per line, and where each spoken character came from in the
 * markdown. Speech engines read newlines as spaces, so every heading, paragraph, list item, and
 * table row ends in punctuation to keep its pause. With `words.math`, for replies that render
 * formulas, each formula is read as its words; without it, as the text the reply shows.
 */
export function readAloudSpeech(
  markdown: string,
  skipCodeBlocks: boolean,
  words: ReadAloudWords = {},
): ReadAloudSpeech {
  const speakMath = words.math;
  let text = "";
  const sources: number[] = [];
  const blocks: ReadAloudBlock[] = [];
  const formulas: Array<{ start: number; end: number }> = [];
  // The formula's words, noting where it is when they replace what the reply shows.
  const formula = (tex: string, node: Positioned) => {
    const spoken = speakMath?.(tex);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (spoken !== undefined && start !== undefined && end !== undefined)
      formulas.push({ start, end });
    return spoken ?? tex;
  };
  const push = (run: Run) => {
    text += run.text;
    sources.push(...run.sources);
  };
  const speak = (run: Run, node: Positioned) => {
    let spokenStart: number | null = null;
    let lineStart = 0;
    while (lineStart <= run.text.length) {
      const newline = run.text.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? run.text.length : newline;
      const line: Run = { text: "", sources: [] };
      for (let index = lineStart; index < lineEnd; index++) {
        const character = run.text.charAt(index);
        const space = SPACE.test(character);
        if (space && line.text.endsWith(" ")) continue;
        // Words put in for an emoji or address are padded with spaces; none goes before a comma.
        const next = index + 1 < lineEnd ? run.text.charAt(index + 1) : " ";
        if (PAUSE.test(character) && SPACE.test(next) && line.text.endsWith(" ")) {
          line.text = line.text.slice(0, -1);
          line.sources.pop();
        }
        line.text += space ? " " : character;
        line.sources.push(run.sources[index] ?? ADDED);
      }
      const sentence = trim(line);
      if (sentence.text) {
        if (text) push(added("\n"));
        spokenStart ??= text.length;
        push(sentence);
        if (!SENTENCE_END.test(sentence.text)) push(added("."));
      }
      lineStart = lineEnd + 1;
    }
    const sourceStart = node.position?.start.offset;
    const sourceEnd = node.position?.end.offset;
    if (spokenStart !== null && sourceStart !== undefined && sourceEnd !== undefined)
      blocks.push({ spokenStart, spokenEnd: text.length, sourceStart, sourceEnd });
  };
  const inline = (node: RootContent): Run => {
    if (node.type === "break") return added("\n");
    if (node.type === "html" || node.type === "image" || node.type === "imageReference")
      return added("");
    if (node.type === "inlineMath") return spread(` ${formula(node.value, node)} `, node);
    // Files show as chips and bare addresses in full; both are read the way a person would say them.
    if (node.type === "inlineCode") {
      const path = inlineCodeFilePathCandidate(node.value);
      const file = path ? spokenFile(path) : undefined;
      if (file) return spread(file, node);
    }
    if (node.type === "link") {
      const label = nodeText(node);
      const file = isMarkdownFileLinkLabel(label, node.url) ? spokenFile(node.url) : undefined;
      if (file) return spread(file, node);
      const bare =
        WEB_URL.test(node.url) && [label, `http://${label}`, `https://${label}`].includes(node.url);
      if (bare) return spread(` ${spokenUrl(node.url)} `, node);
    }
    if ("children" in node) return concat(node.children.map(inline));
    if (node.type === "text" || node.type === "inlineCode") {
      const keys = sayAs(located(markdown, node.value, node), KEYS, sayKeys);
      const emoji = words.emoji;
      return node.type === "text" && emoji ? sayAs(keys, EMOJI, emoji) : keys;
    }
    return "value" in node ? located(markdown, node.value, node) : added("");
  };
  const block = (node: Root | RootContent) => {
    if (node.type === "paragraph" || node.type === "heading") speak(inline(node), node);
    else if (node.type === "tableRow")
      speak(
        concat(
          node.children
            .map((cell) => trim(inline(cell)))
            .filter((cell) => cell.text)
            .flatMap((cell, index) => (index ? [added(", "), cell] : [cell])),
        ),
        node,
      );
    else if (node.type === "math" || (speakMath && node.type === "code" && node.lang === "math"))
      speak(spread(formula(node.value, node), node), node);
    else if (node.type === "code") {
      // A diagram's source says nothing a listener can follow.
      if (!skipCodeBlocks && node.lang !== "mermaid")
        speak(located(markdown, node.value, node), node);
    } else if (node.type !== "html" && node.type !== "definition" && "children" in node)
      for (const child of node.children) block(child);
  };
  block(
    speakMath && mayContainMath(markdown)
      ? parseMarkdownWithMath(markdown)
      : parser.parse(markdown),
  );
  return { text, sources, blocks, formulas };
}

export function readAloudText(markdown: string, skipCodeBlocks: boolean, words?: ReadAloudWords) {
  return readAloudSpeech(markdown, skipCodeBlocks, words).text;
}

/** Splits at sentence ends below `limit`; `start` is each piece's offset in `text`. */
export function splitReadAloudSpans(text: string, limit = 3500) {
  const spans: Array<{ readonly start: number; readonly text: string }> = [];
  let rest = text.trim();
  let offset = text.length - text.trimStart().length;
  while (rest.length > limit) {
    const part = rest.slice(0, limit);
    const sentence = [...part.matchAll(/[.!?。！？](?:\s|$)/gu)].at(-1);
    let at = sentence ? sentence.index + sentence[0].length : part.lastIndexOf(" ");
    if (at <= 0) at = limit;
    if (/[\uD800-\uDBFF]/.test(rest[at - 1] ?? "")) at--;
    spans.push({ start: offset, text: rest.slice(0, at).trim() });
    const next = rest.slice(at);
    rest = next.trim();
    offset += at + next.length - next.trimStart().length;
  }
  if (rest) spans.push({ start: offset, text: rest });
  return spans;
}

// Longer lead-ins delay the word picked by more speech than they are worth.
const MAX_LEAD_IN = 400;

/**
 * Where to start speech that should be heard from offset `at`: the start of its sentence, so the
 * voice reads the word in context, unless that sentence runs too long before it.
 */
export function readAloudSentenceStart(text: string, at: number) {
  const ends = [...text.slice(0, at).matchAll(/[.!?。！？]\s+|\n/gu)];
  const end = ends.at(-1);
  const start = end ? end.index + end[0].length : 0;
  return at - start > MAX_LEAD_IN ? at : start;
}

export function splitReadAloudText(text: string, limit = 3500) {
  return splitReadAloudSpans(text, limit).map((span) => span.text);
}

/** The whitespace-delimited word of `text` that holds `index`, such as a speech boundary. */
export function spokenWordAt(text: string, index: number) {
  let start = Math.max(0, Math.min(index, text.length));
  while (start < text.length && SPACE.test(text.charAt(start))) start++;
  let end = start;
  while (start > 0 && !SPACE.test(text.charAt(start - 1))) start--;
  while (end < text.length && !SPACE.test(text.charAt(end))) end++;
  return { start, end };
}

/**
 * A word as a renderer finds it: the text shown for it and how many times that text appears
 * earlier in its block. Renderers search their own text, which can differ from the markdown.
 */
export interface ReadAloudCue {
  readonly text: string;
  readonly occurrence: number;
}

/** What is being read, as markdown offsets plus cues for renderers that search their text. */
export interface ReadAloudPosition {
  /** `first` and `last` are null for a block shown only as math, such as a block formula. */
  readonly block: {
    readonly start: number;
    readonly end: number;
    readonly first: ReadAloudCue | null;
    readonly last: ReadAloudCue | null;
  };
  /** `cue` is null for a word spoken for a formula, which renderers show as math. */
  readonly word: {
    readonly start: number;
    readonly end: number;
    readonly cue: ReadAloudCue | null;
  };
}

const occurrences = (text: string, find: string) => {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) count++;
  return count;
};

/** The block and word at a spoken range, or null when the range has no markdown source. */
export function readAloudPosition(
  speech: ReadAloudSpeech,
  spokenStart: number,
  spokenEnd: number,
): ReadAloudPosition | null {
  const block = speech.blocks.find(
    (entry) => spokenStart >= entry.spokenStart && spokenStart < entry.spokenEnd,
  );
  if (!block) return null;
  // A rendered formula is no text a renderer can search, so cues leave its words out.
  const shownAt = (index: number) => {
    const source = speech.sources[index] ?? ADDED;
    return (
      source !== ADDED &&
      !speech.formulas.some((range) => source >= range.start && source < range.end)
    );
  };
  const shown = (start: number, end: number) => {
    let result = "";
    for (let index = start; index < end; index++) if (shownAt(index)) result += speech.text[index];
    return result;
  };
  const cue = (start: number, end: number) => {
    const text = shown(start, end);
    return text
      ? { text, occurrence: occurrences(shown(block.spokenStart, start), text) }
      : undefined;
  };
  // The block's outermost words with shown text, past any formula at either end.
  const cues = [...speech.text.slice(block.spokenStart, block.spokenEnd).matchAll(/\S+/g)]
    .map((word) =>
      cue(block.spokenStart + word.index, block.spokenStart + word.index + word[0].length),
    )
    .filter((entry) => entry !== undefined);
  const wordSources = speech.sources
    .slice(spokenStart, spokenEnd)
    .filter((source) => source !== ADDED);
  if (wordSources.length === 0) return null;
  return {
    block: {
      start: block.sourceStart,
      end: block.sourceEnd,
      first: cues[0] ?? null,
      last: cues.at(-1) ?? null,
    },
    word: {
      start: Math.min(...wordSources),
      end: Math.max(...wordSources) + 1,
      cue: cue(spokenStart, spokenEnd) ?? null,
    },
  };
}

/** A UTF-16 range of the text a renderer shows. */
export interface ReadAloudTextRange {
  readonly start: number;
  readonly end: number;
}

type ComparedWord = ReadAloudTextRange & { readonly key: string };

/** How far ahead a word may be found before the match is resynchronized on a run of words. */
const ALIGN_WINDOW = 8;
const RESYNC_RUN = 3;

/** Words of `text` compared by letters and digits only, so markup and punctuation do not count. */
function comparedWords(text: string): ComparedWord[] {
  const words: ComparedWord[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const key = match[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (key) words.push({ key, start: match.index, end: match.index + match[0].length });
  }
  return words;
}

/**
 * The shown word each spoken word appears as, or -1. Matches move forward; a skip needs the next
 * words to agree, and a lost match resyncs on the next run of equal words anywhere ahead.
 */
function alignWords(spoken: ReadonlyArray<ComparedWord>, shown: ReadonlyArray<ComparedWord>) {
  const anchors = Array.from(spoken, () => -1);
  const agrees = (from: number, to: number, length: number) => {
    for (let offset = 0; offset < length; offset++) {
      const a = spoken[from + offset];
      const b = shown[to + offset];
      if (!a || !b) return offset > 0;
      if (a.key !== b.key) return false;
    }
    return true;
  };
  let i = 0;
  let j = 0;
  // A lone equal word is trusted only right after a match; elsewhere "the" would match anywhere.
  let synced = false;
  while (i < spoken.length && j < shown.length) {
    let next: { i: number; j: number } | null = null;
    for (let distance = 0; distance <= ALIGN_WINDOW && !next; distance++)
      for (let skip = 0; skip <= distance && !next; skip++)
        if (agrees(i + skip, j + distance - skip, distance === 0 && synced ? 1 : 2))
          next = { i: i + skip, j: j + distance - skip };
    if (!next)
      for (let at = j + 1; at < shown.length && !next; at++)
        if (agrees(i, at, RESYNC_RUN)) next = { i, j: at };
    synced = next !== null;
    if (!next) {
      i++;
      continue;
    }
    anchors[next.i] = next.j;
    i = next.i + 1;
    j = next.j + 1;
  }
  return anchors;
}

/** How a renderer shows the reply: `math` when it draws formulas rather than their TeX. */
export interface ReadAloudShownOptions {
  readonly math?: boolean;
}

/**
 * The reply's spoken words, the words `shown` holds, and the shown word each spoken one matched.
 * Formulas drawn as math show no words, so their TeX is left out of the match.
 */
function alignShown(markdown: string, shown: string, options: ReadAloudShownOptions) {
  const speech = readAloudSpeech(markdown, false);
  const formulas = options.math ? markdownMathRanges(markdown) : [];
  const spoken = comparedWords(speech.text).map((word) => {
    const sources = speech.sources.slice(word.start, word.end).filter((at) => at !== ADDED);
    const sourceStart = Math.min(...sources);
    const sourceEnd = Math.max(...sources) + 1;
    const drawn = formulas.some((range) => sourceStart < range.end && sourceEnd > range.start);
    return { ...word, sourceStart, sourceEnd, drawn };
  });
  const shownWords = comparedWords(shown);
  const matchable = spoken.flatMap((word, index) => (word.drawn ? [] : [index]));
  const matched = alignWords(
    matchable.map((index) => spoken[index]!),
    shownWords,
  );
  const anchors = Array.from(spoken, () => -1);
  matchable.forEach((index, at) => {
    anchors[index] = matched[at] ?? -1;
  });
  return { spoken, shownWords, anchors };
}

/** The line of `text` around `range`: where renderers put each paragraph, item, and row. */
function shownLine(text: string, range: ReadAloudTextRange): ReadAloudTextRange {
  const end = text.indexOf("\n", range.end);
  return {
    start: text.lastIndexOf("\n", range.start - 1) + 1,
    end: end === -1 ? text.length : end,
  };
}

/**
 * Finds what read aloud is reading in a renderer's own text, such as a native view that reports
 * the text it shows but not where it came from in the markdown. The reply's words are matched to
 * the shown words in order. Words shown some other way, such as a formula, a file chip, or an
 * emoji, are found between the matched words around them; the block is its whole lines.
 */
export function readAloudShownText(
  markdown: string,
  shown: string,
  options: ReadAloudShownOptions = {},
) {
  const { spoken, shownWords, anchors } = alignShown(markdown, shown, options);
  const matched = (index: number) => shownWords[anchors[index] ?? -1];
  const span = (inside: (word: (typeof spoken)[number]) => boolean): ReadAloudTextRange | null => {
    let start = Infinity;
    let end = -Infinity;
    let first = -1;
    let last = -1;
    spoken.forEach((word, index) => {
      if (!inside(word)) return;
      if (first === -1) first = index;
      last = index;
      const match = matched(index);
      if (!match) return;
      start = Math.min(start, match.start);
      end = Math.max(end, match.end);
    });
    if (start < end) return { start, end };
    if (first === -1) return null;
    // None of them matched: what shows between the matched words around them, on one line.
    let before = 0;
    for (let index = first - 1; index >= 0 && !before; index--) before = matched(index)?.end ?? 0;
    let after = shown.length;
    for (let index = last + 1; index < spoken.length && after === shown.length; index++)
      after = matched(index)?.start ?? shown.length;
    const between = shown.slice(before, after);
    const lead = between.length - between.trimStart().length;
    const text = between.trim();
    return text && !text.includes("\n")
      ? { start: before + lead, end: before + lead + text.length }
      : null;
  };
  return (position: ReadAloudPosition) => {
    const word = span(
      (entry) => entry.sourceStart < position.word.end && entry.sourceEnd > position.word.start,
    );
    const block =
      span(
        (entry) =>
          entry.sourceStart >= position.block.start && entry.sourceEnd <= position.block.end,
      ) ?? word;
    return { block: block && shownLine(shown, block), word };
  };
}

/**
 * The markdown offset of the first word a renderer shows at or after `offset` of its text `shown`,
 * such as the place a user taps, or null when no later word matches the reply.
 */
export function readAloudSourceAtShown(
  markdown: string,
  shown: string,
  offset: number,
  options: ReadAloudShownOptions = {},
) {
  const { spoken, shownWords, anchors } = alignShown(markdown, shown, options);
  for (const [index, word] of spoken.entries()) {
    const match = shownWords[anchors[index] ?? -1];
    if (match && match.end > offset) return word.sourceStart;
  }
  return null;
}

/**
 * Where a tap at `offset` of a renderer's text `shown` reads from: the word there or next on its
 * line (`word`), else the line's block, as the markdown offset of a word in it. Null when nothing
 * on the line matches the reply.
 */
export function readAloudTapAtShown(
  markdown: string,
  shown: string,
  offset: number,
  options: ReadAloudShownOptions = {},
) {
  const { spoken, shownWords, anchors } = alignShown(markdown, shown, options);
  const line = shownLine(shown, { start: offset, end: offset });
  let block: number | null = null;
  for (const [index, word] of spoken.entries()) {
    const match = shownWords[anchors[index] ?? -1];
    if (!match || match.start < line.start || match.end > line.end) continue;
    if (match.end > offset) return { from: word.sourceStart, word: true };
    block ??= word.sourceStart;
  }
  return block === null ? null : { from: block, word: false };
}

/** The first spoken block that ends after markdown offset `from`: where reading from it starts. */
export function readAloudBlockFrom(speech: ReadAloudSpeech, from: number) {
  return speech.blocks.find((block) => block.sourceEnd > from);
}

// As often as dictation's meter and with its smoothing. Speech audio is mastered quieter than a
// close microphone, so it is scaled up more to fill the same waveform.
/** How often the read-aloud meter moves, wherever the loudness is measured. */
export const READ_ALOUD_LEVEL_INTERVAL_MS = 50;
const READ_ALOUD_LEVEL_GAIN = 8;
const READ_ALOUD_LEVEL_ATTACK = Math.exp(-READ_ALOUD_LEVEL_INTERVAL_MS / 75);
const READ_ALOUD_LEVEL_RELEASE = Math.exp(-READ_ALOUD_LEVEL_INTERVAL_MS / 200);

/** The meter's level, from 0 to 1, for audio whose samples (-1 to 1) average `meanSquare`. */
export function readAloudLevel(meanSquare: number) {
  return Math.min(1, Math.sqrt(meanSquare) * READ_ALOUD_LEVEL_GAIN) || 0;
}

/** Eases the meter from `previous` toward `target`: quick to rise, slower to fall. */
export function smoothReadAloudLevel(previous: number, target: number) {
  return (
    target +
    (previous - target) * (target > previous ? READ_ALOUD_LEVEL_ATTACK : READ_ALOUD_LEVEL_RELEASE)
  );
}
