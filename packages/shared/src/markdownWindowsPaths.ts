import type { Processor } from "unified";
import {
  protectSpacedWindowsDestinations,
  restoreWindowsDestinationSpaces,
} from "./markdownLinks.ts";
import { isWindowsAbsolutePath } from "./path.ts";

interface RestorableNode {
  value?: unknown;
  url?: unknown;
  children?: RestorableNode[];
}

function restoreTreeDestinationSpaces(node: RestorableNode) {
  if (typeof node.url === "string") node.url = restoreWindowsDestinationSpaces(node.url);
  if (typeof node.value === "string") node.value = restoreWindowsDestinationSpaces(node.value);
  node.children?.forEach(restoreTreeDestinationSpaces);
}

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

function keepWindowsPathEscape(this: EscapeCompileContext) {
  const text = this.stack.at(-1)?.children?.at(-1);
  if (text?.type !== "text" || text.value === undefined) return;
  const before = text.value.slice(0, -1);
  if (UNFINISHED_DRIVE_PATH.test(before)) {
    text.value = `${before}\\${text.value.slice(-1)}`;
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
  const parse = this.parser;
  if (!parse) return;
  // Restore before returning, so parsers that cache this tree (streaming) keep the real spaces.
  this.parser = (document, file) => {
    const protectedDocument = protectSpacedWindowsDestinations(document);
    const tree = parse(protectedDocument, file);
    if (protectedDocument !== document) restoreTreeDestinationSpaces(tree as RestorableNode);
    return tree;
  };
}
