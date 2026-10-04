export interface StreamingMarkdownSegment {
  readonly start: number;
  readonly text: string;
}

export interface StreamingMarkdownSegments {
  readonly mode: "segments" | "full";
  readonly sourceText: string;
  readonly completed: ReadonlyArray<StreamingMarkdownSegment>;
  readonly tailStart: number;
  readonly tailText: string;
  readonly scanFrom: number;
}

interface ParagraphBoundary {
  readonly start: number;
  readonly end: number;
}

const CONTEXT_SENSITIVE_MARKER_PATTERN = /[[\]`<>|#]/;
const BLOCK_START_PATTERN =
  /(?:^|\r?\n)[ \t]{0,3}(?:#{1,6}[ \t]+|>|(?:[-+*]|\d{1,9}[.)])[ \t]+|(?:`{3,}|~{3,})|[ \t]{4,})/;
const SETEXT_OR_THEMATIC_BREAK_PATTERN =
  /(?:^|\r?\n)[ \t]{0,3}(?:={3,}|-{3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*(?:\r?\n|$)/;

const emptySegments = (): StreamingMarkdownSegments => ({
  mode: "segments",
  sourceText: "",
  completed: [],
  tailStart: 0,
  tailText: "",
  scanFrom: 0,
});

const fullDocument = (sourceText: string): StreamingMarkdownSegments => ({
  mode: "full",
  sourceText,
  completed: [],
  tailStart: 0,
  tailText: "",
  scanFrom: 0,
});

function findParagraphBoundary(text: string, from: number): ParagraphBoundary | null {
  let newlineIndex = text.indexOf("\n", from);
  while (newlineIndex >= 0) {
    let blankLineIndex = newlineIndex + 1;
    if (text[blankLineIndex] === "\r") {
      blankLineIndex += 1;
    }
    while (text[blankLineIndex] === " " || text[blankLineIndex] === "\t") {
      blankLineIndex += 1;
    }
    if (text[blankLineIndex] === "\r" && text[blankLineIndex + 1] === "\n") {
      blankLineIndex += 1;
    }
    if (text[blankLineIndex] === "\n") {
      return {
        start:
          newlineIndex > 0 && text[newlineIndex - 1] === "\r" ? newlineIndex - 1 : newlineIndex,
        end: blankLineIndex + 1,
      };
    }
    newlineIndex = text.indexOf("\n", newlineIndex + 1);
  }
  return null;
}

function nextBoundaryScanOffset(text: string): number {
  const newlineIndex = text.lastIndexOf("\n");
  if (newlineIndex >= 0 && /^[\r \t]*$/.test(text.slice(newlineIndex + 1))) {
    return newlineIndex > 0 && text[newlineIndex - 1] === "\r" ? newlineIndex - 1 : newlineIndex;
  }
  return Math.max(0, text.length - 2);
}

function isIndependentParagraph(text: string): boolean {
  return (
    !CONTEXT_SENSITIVE_MARKER_PATTERN.test(text) &&
    !BLOCK_START_PATTERN.test(text) &&
    !SETEXT_OR_THEMATIC_BREAK_PATTERN.test(text)
  );
}

export function beginStreamingMarkdown(sourceText: string): StreamingMarkdownSegments {
  return appendStreamingMarkdown(emptySegments(), sourceText);
}

/**
 * Reuses completed, context-independent paragraphs and leaves the active tail
 * for ReactMarkdown to parse. Syntax whose meaning may depend on later blocks
 * stays on the full-document path.
 */
export function appendStreamingMarkdown(
  previous: StreamingMarkdownSegments,
  sourceText: string,
): StreamingMarkdownSegments {
  if (sourceText === previous.sourceText) {
    return previous;
  }
  if (previous.mode === "full" || !sourceText.startsWith(previous.sourceText)) {
    return fullDocument(sourceText);
  }

  const appendedText = sourceText.slice(previous.sourceText.length);
  if (CONTEXT_SENSITIVE_MARKER_PATTERN.test(appendedText)) {
    return fullDocument(sourceText);
  }

  let tailText = previous.tailText + appendedText;
  let tailStart = previous.tailStart;
  let completed = previous.completed;
  let nextCompleted: Array<StreamingMarkdownSegment> | undefined;
  let scanFrom = previous.scanFrom;

  while (true) {
    const boundary = findParagraphBoundary(tailText, scanFrom);
    if (boundary === null) {
      scanFrom = nextBoundaryScanOffset(tailText);
      break;
    }

    const paragraph = tailText.slice(0, boundary.start);
    if (paragraph.trim().length > 0) {
      if (!isIndependentParagraph(paragraph)) {
        return fullDocument(sourceText);
      }
      nextCompleted ??= [...completed];
      nextCompleted.push({ start: tailStart, text: paragraph });
    }

    tailStart += boundary.end;
    tailText = tailText.slice(boundary.end);
    scanFrom = 0;
  }

  if (nextCompleted !== undefined) {
    completed = nextCompleted;
  }
  return {
    mode: "segments",
    sourceText,
    completed,
    tailStart,
    tailText,
    scanFrom,
  };
}
