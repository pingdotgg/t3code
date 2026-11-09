import type { Processor } from "unified";
import { isWindowsAbsolutePath } from "./path.ts";

interface DestinationCompileContext {
  readonly stack: ReadonlyArray<{ readonly type: string; url?: string }>;
  resume(): string;
  sliceSerialize(token: unknown): string;
}

function keepWindowsPathDestination(this: DestinationCompileContext, token: unknown) {
  const decoded = this.resume();
  const authored = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  // Character references still need decoding, so those destinations keep the parsed URL.
  if (node)
    node.url = isWindowsAbsolutePath(authored) && !authored.includes("&") ? authored : decoded;
}

// A drive path that has not reached whitespace yet: `C:`, `C:\Users\me`, `C:/work`.
const UNFINISHED_DRIVE_PATH = /(?:^|\W)[A-Za-z]:(?:[\\/]\S*)?$/;

interface EscapeCompileContext {
  readonly stack: ReadonlyArray<{
    readonly type: string;
    children?: Array<{ type: string; value?: string }>;
  }>;
}

const WHITESPACE_LOOKBACK = 64;

function isAsciiWhitespace(code: number) {
  return code === 32 || (code >= 9 && code <= 13);
}

function keepWindowsPathEscape(this: EscapeCompileContext) {
  const text = this.stack.at(-1)?.children?.at(-1);
  if (text?.type !== "text" || text.value === undefined) return;
  // A drive path cannot cross whitespace, so only the run this escape ends can hold one.
  // ASCII whitespace bounds it; a run spanning other spaces is longer but matches the same.
  // Runs longer than the lookback test the whole text, which is never slower than scanning it twice.
  const { value } = text;
  const end = value.length - 1;
  const floor = Math.max(0, end - WHITESPACE_LOOKBACK);
  let start = end;
  while (start > floor && !isAsciiWhitespace(value.charCodeAt(start - 1))) start -= 1;
  if (start === floor) start = 0;
  if (UNFINISHED_DRIVE_PATH.test(value.slice(start, end))) {
    text.value = `${value.slice(0, end)}\\${value.slice(end)}`;
  }
}

function keepWindowsProsePathEscape(this: EscapeCompileContext) {
  // Destinations, titles, and labels are buffered in a fragment.
  if (this.stack.at(-1)?.type !== "fragment") keepWindowsPathEscape.call(this);
}

/**
 * Keeps escapes inside drive paths in prose only, for parsers that already escape Windows
 * destinations themselves. Prose paths end at whitespace: past that, nothing tells a path
 * from a sentence, and `C:\x and \*this\*` must still read `*this*`.
 */
export function remarkKeepWindowsProsePaths(this: Processor) {
  (this.data().fromMarkdownExtensions ??= []).push({
    exit: { characterEscape: keepWindowsProsePathEscape },
  });
}

/**
 * CommonMark reads the `\.` in `C:\me\.t3\shot.png` as an escape. Every backslash in a
 * Windows path is a separator, so link, image, and definition destinations that are
 * Windows paths keep the text as written, and so do escapes inside drive paths.
 */
export function remarkKeepWindowsPaths(this: Processor) {
  (this.data().fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
      characterEscape: keepWindowsPathEscape,
    },
  });
}
