/**
 * Turns a reply's markdown into text that sounds right when read aloud:
 * code blocks become "Code block.", links keep their words, file paths are
 * read as their file name, and markdown symbols are dropped.
 */

const CODE_BLOCK_SPOKEN = "Code block.";
const LONG_INLINE_CODE = 48;

const URL_PATTERN = /\b(?:https?|file):\/\/[^\s)>\]]+/gi;
// A token with at least one / or \ between name characters, such as
// apps/web/src/App.tsx, C:\Users\Ryan\notes.md or ~/.claude/settings.json.
const PATH_PATTERN =
  /(?:[A-Za-z]:)?(?:[~.]{0,2}[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+(?::\d+(?::\d+)?)?/g;

function fileNameOf(path: string): string {
  const withoutLine = path.replace(/:\d+(?::\d+)?$/, "");
  const parts = withoutLine.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? withoutLine;
}

function speakInlineCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) return "";
  if (/^[\w.@~:-]*[\\/]/.test(trimmed) && !/\s/.test(trimmed)) return fileNameOf(trimmed);
  if (trimmed.length > LONG_INLINE_CODE) return "code";
  return trimmed;
}

function speakProse(line: string): string {
  return (
    line
      // Images keep their alt text, links keep their words.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<((?:https?|file):[^>]+)>/gi, "link")
      .replace(URL_PATTERN, "link")
      // Inline code, before paths so `a/b.ts` is handled once.
      .replace(/`([^`]+)`/g, (_match, code: string) => speakInlineCode(code))
      .replace(PATH_PATTERN, (match) => fileNameOf(match))
      // Emoji would be read out by name ("speaker high volume").
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
      // HTML tags and markdown emphasis.
      .replace(/<\/?[A-Za-z][^>]*>/g, "")
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
  );
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return /[.!?:;…]["')\]]?$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function markdownToSpeechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text.length > 0) blocks.push(endSentence(text));
    paragraph = [];
  };

  for (const rawLine of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(rawLine);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      fence = fenceMatch[1]!;
      if (blocks[blocks.length - 1] !== CODE_BLOCK_SPOKEN) blocks.push(CODE_BLOCK_SPOKEN);
      continue;
    }

    const line = rawLine.trim();
    if (line.length === 0 || /^(?:[-*_]\s*){3,}$/.test(line)) {
      flushParagraph();
      continue;
    }
    // Table separator rows say nothing; other rows read their cells.
    if (/^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;
    if (line.startsWith("|")) {
      flushParagraph();
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => speakProse(cell).trim())
        .filter((cell) => cell.length > 0);
      if (cells.length > 0) blocks.push(endSentence(cells.join(", ")));
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const listItem = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (heading || listItem) {
      flushParagraph();
      const text = speakProse((heading ?? listItem)![1]!);
      if (text.trim().length > 0) blocks.push(endSentence(text));
      continue;
    }

    paragraph.push(speakProse(line.replace(/^>\s?/, "")));
  }
  flushParagraph();

  return blocks
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Splits speech text into pieces that are synthesized one after another, so
 * the first words play quickly. The first piece is short; later ones are
 * longer. Pieces break at line or sentence ends where possible.
 */
export function splitSpeechText(text: string, firstMax = 140, restMax = 600): string[] {
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [line])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const max = chunks.length === 0 ? firstMax : restMax;
    if (current.length > 0 && current.length + 1 + sentence.length > max) {
      chunks.push(current);
      current = "";
    }
    if (sentence.length > restMax) {
      // A very long "sentence" (no punctuation): cut at word boundaries.
      for (const part of sentence.match(new RegExp(`.{1,${restMax}}(?:\\s|$)`, "g")) ?? []) {
        if (current.length > 0) chunks.push(current);
        current = part.trim();
      }
      continue;
    }
    current = current.length > 0 ? `${current} ${sentence}` : sentence;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
