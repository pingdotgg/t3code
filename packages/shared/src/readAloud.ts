import type { Node, RootContent, Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

// Already ends a sentence, allowing closing quotes or brackets after the punctuation.
const SENTENCE_END = /[.!?…:;。！？：；]["'”’)\]]*$/u;
const SPACE = /\s/;

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

/**
 * Plain text with one sentence per line, and where each spoken character came from in the
 * markdown. Speech engines read newlines as spaces, so every heading, paragraph, list item, and
 * table row ends in punctuation to keep its pause.
 */
export function readAloudSpeech(markdown: string, skipCodeBlocks: boolean): ReadAloudSpeech {
  let text = "";
  const sources: number[] = [];
  const blocks: ReadAloudBlock[] = [];
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
    if ("children" in node) return concat(node.children.map(inline));
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
    else if (node.type === "code") {
      if (!skipCodeBlocks) speak(located(markdown, node.value, node), node);
    } else if (node.type !== "html" && node.type !== "definition" && "children" in node)
      for (const child of node.children) block(child);
  };
  block(parser.parse(markdown));
  return { text, sources, blocks };
}

export function readAloudText(markdown: string, skipCodeBlocks: boolean) {
  return readAloudSpeech(markdown, skipCodeBlocks).text;
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
  readonly block: {
    readonly start: number;
    readonly end: number;
    readonly first: ReadAloudCue;
    readonly last: ReadAloudCue;
  };
  readonly word: { readonly start: number; readonly end: number; readonly cue: ReadAloudCue };
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
  const shown = (start: number, end: number) => {
    let result = "";
    for (let index = start; index < end; index++)
      if ((speech.sources[index] ?? ADDED) !== ADDED) result += speech.text[index];
    return result;
  };
  const cue = (start: number, end: number) => {
    const text = shown(start, end);
    return text
      ? { text, occurrence: occurrences(shown(block.spokenStart, start), text) }
      : undefined;
  };
  const words = [...speech.text.slice(block.spokenStart, block.spokenEnd).matchAll(/\S+/g)];
  const first = words[0];
  const last = words.at(-1);
  const firstCue =
    first &&
    cue(block.spokenStart + first.index, block.spokenStart + first.index + first[0].length);
  const lastCue =
    last && cue(block.spokenStart + last.index, block.spokenStart + last.index + last[0].length);
  const wordCue = cue(spokenStart, spokenEnd);
  const wordSources = speech.sources
    .slice(spokenStart, spokenEnd)
    .filter((source) => source !== ADDED);
  if (!firstCue || !lastCue || !wordCue || wordSources.length === 0) return null;
  return {
    block: { start: block.sourceStart, end: block.sourceEnd, first: firstCue, last: lastCue },
    word: { start: Math.min(...wordSources), end: Math.max(...wordSources) + 1, cue: wordCue },
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

/**
 * Finds what read aloud is reading in a renderer's own text, such as a native view that reports
 * the text it shows but not where it came from in the markdown. The reply's words are matched to
 * the shown words in order; a word without a safe match is left unhighlighted.
 */
export function readAloudShownText(markdown: string, shown: string) {
  const speech = readAloudSpeech(markdown, false);
  const spoken = comparedWords(speech.text).map((word) => {
    const sources = speech.sources.slice(word.start, word.end).filter((at) => at !== ADDED);
    return { ...word, sourceStart: Math.min(...sources), sourceEnd: Math.max(...sources) + 1 };
  });
  const shownWords = comparedWords(shown);
  const anchors = alignWords(spoken, shownWords);
  const span = (inside: (word: (typeof spoken)[number]) => boolean): ReadAloudTextRange | null => {
    let start = Infinity;
    let end = -Infinity;
    spoken.forEach((word, index) => {
      const match = shownWords[anchors[index] ?? -1];
      if (!match || !inside(word)) return;
      start = Math.min(start, match.start);
      end = Math.max(end, match.end);
    });
    return start < end ? { start, end } : null;
  };
  return (position: ReadAloudPosition) => ({
    block: span(
      (word) => word.sourceStart >= position.block.start && word.sourceEnd <= position.block.end,
    ),
    word: span(
      (word) => word.sourceStart < position.word.end && word.sourceEnd > position.word.start,
    ),
  });
}
