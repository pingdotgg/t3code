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

/**
 * CommonMark reads the `\.` in `C:\me\.t3\shot.png` as an escape. Every backslash in a
 * Windows path is a separator, so link, image, and definition destinations that are
 * Windows paths keep the text as written, and so do escapes inside drive paths in prose.
 * Prose paths end at whitespace: past that, nothing tells a path from a sentence, and
 * `C:\x and \*this\*` must still read `*this*`.
 */
export function remarkKeepWindowsPaths(this: Processor) {
  function keepWindowsPathEscape(this: EscapeCompileContext) {
    const text = this.stack.at(-1)?.children?.at(-1);
    if (text?.type !== "text" || text.value === undefined) return;
    const before = text.value.slice(0, -1);
    if (UNFINISHED_DRIVE_PATH.test(before)) {
      text.value = `${before}\\${text.value.slice(-1)}`;
    }
  }

  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
      characterEscape: keepWindowsPathEscape,
    },
  });
}
