import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import {
  markdownForNativeParsing,
  markdownForNativeRendering,
  markdownMayLinkFiles,
  markdownRenderParsed,
  markdownWithFileEmbeds,
  markdownWithInlineFileLinks,
  markdownWithTableBreaks,
} from "./markdownDocument";

export interface NativeMarkdownRender {
  readonly markdown: string;
  readonly fileHrefs: ReadonlySet<string>;
}

type FileEmbedLabel = (href: string, standalone: boolean) => string | null;

/** The conversion every Markdown view applies to its whole text before the native view draws it. */
export function convertNativeMarkdown(
  markdown: string,
  fileEmbedLabel: FileEmbedLabel | undefined,
): NativeMarkdownRender {
  if (!fileEmbedLabel) {
    return {
      markdown: markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX),
      fileHrefs: new Set<string>(),
    };
  }
  const content = markdownWithInlineFileLinks(
    markdownForNativeParsing(markdown),
    ENRICHED_INLINE_FILE_LINK_REGEX,
  );
  const files = markdownWithFileEmbeds(content, fileEmbedLabel);
  return { ...files, markdown: markdownWithTableBreaks(files.markdown) };
}

/**
 * `convertNativeMarkdown` cut in two at the one decision it takes for the whole document
 * (whether file links are rewritten), so a piece of the text can be converted on its own.
 */
export interface NativeMarkdownPipeline {
  /** The passes that come before the file-link decision. */
  parse(block: string): string;
  /** Whether the parsed block holds an inline-code span that may become a file link. */
  mayLinkFiles(parsed: string): boolean;
  /** The remaining passes, given the decision for the whole document. */
  render(parsed: string, linkFiles: boolean): NativeMarkdownRender;
}

export function nativeMarkdownPipeline(
  fileEmbedLabel: FileEmbedLabel | undefined,
): NativeMarkdownPipeline {
  return {
    parse: markdownForNativeParsing,
    mayLinkFiles: (parsed) => markdownMayLinkFiles(parsed, ENRICHED_INLINE_FILE_LINK_REGEX),
    render: (parsed, linkFiles) => {
      if (!fileEmbedLabel) {
        return {
          markdown: markdownRenderParsed(parsed, ENRICHED_INLINE_FILE_LINK_REGEX, linkFiles),
          fileHrefs: new Set<string>(),
        };
      }
      const content = markdownWithInlineFileLinks(
        parsed,
        ENRICHED_INLINE_FILE_LINK_REGEX,
        linkFiles,
      );
      const files = markdownWithFileEmbeds(content, fileEmbedLabel);
      return { ...files, markdown: markdownWithTableBreaks(files.markdown) };
    },
  };
}

// Ties blocks together: a reference definition (`]:`, even in a quote or list or over several
// lines) that any block may use, or an HTML block that runs past a blank line.
const UNSAFE_LINE = /\]:|^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*<[A-Za-z!?/]/;
// The parser drops a byte-order mark, which would shift every offset after it.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
// CommonMark blank lines hold only spaces and tabs; `trim()` would also accept NBSP and friends.
const BLANK_LINE = /^[ \t]*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/** Shorter text converts in a few milliseconds, so it keeps the plain whole-text conversion. */
export const NATIVE_MARKDOWN_BLOCK_MIN_LENGTH = 2048;

function fenceOpener(line: string): string | undefined {
  const opener = FENCE_PATTERN.exec(line)?.[1];
  // A backtick fence cannot have a backtick in its info string, so that line is inline code.
  if (opener && opener[0] === "`" && line.indexOf("`", line.indexOf(opener) + opener.length) !== -1)
    return undefined;
  return opener;
}

/**
 * Cuts Markdown at blank lines that close every open block, so each piece converts the way it
 * does inside the whole text. Returns null when the text has syntax that can tie blocks together.
 */
export function splitMarkdownStreamBlocks(text: string): string[] | null {
  if (text.includes("\r") || text.includes(BYTE_ORDER_MARK) || text.includes("\0")) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = fenceOpener(line);
    // Backticks in the info string make this inline code, but rewriting that code into a file
    // link removes them and turns the line into a fence for the passes that follow.
    if (fence === null && !opener && FENCE_PATTERN.test(line)) return null;
    // An indented fence may belong to a list item, so only a top-level fence hides its lines.
    if ((fence === null || fenceIndent > 0) && UNSAFE_LINE.test(line)) return null;
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) return null;
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        FENCE_CLOSER.test(line)
      ) {
        fence = null;
      }
    } else if (BLANK_LINE.test(line)) {
      afterBlankLine = true;
    } else {
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

function splitsAsParsed(parsed: readonly string[]): boolean {
  const resplit = splitMarkdownStreamBlocks(parsed.join(""));
  return (
    resplit !== null &&
    resplit.length === parsed.length &&
    resplit.every((block, index) => block === parsed[index])
  );
}

interface BlockEntry {
  readonly parsed: string;
  readonly mayLinkFiles: boolean;
  // Indexed by the file-link decision for the whole document.
  readonly renders: [NativeMarkdownRender | undefined, NativeMarkdownRender | undefined];
}

/** Converted blocks of the previous update, valid for one `owner` (the file-embed callback). */
export interface NativeMarkdownBlockCache {
  owner: unknown;
  blocks: Map<string, BlockEntry>;
}

export function createNativeMarkdownBlockCache(): NativeMarkdownBlockCache {
  return { owner: undefined, blocks: new Map() };
}

/**
 * Converts text that is still streaming one block at a time and reuses every block that did not
 * change since the previous call, so an update converts only its last block. Returns null when
 * the caller must convert the whole text: the text is not streaming, is short, or has syntax that
 * can tie blocks together. Finished text therefore always gets the whole-text conversion.
 */
export function convertStreamingMarkdown(
  markdown: string,
  owner: unknown,
  cache: NativeMarkdownBlockCache,
  streaming: boolean,
  pipeline: NativeMarkdownPipeline,
  minLength: number = NATIVE_MARKDOWN_BLOCK_MIN_LENGTH,
): NativeMarkdownRender | null {
  const blocks =
    streaming && markdown.length >= minLength ? splitMarkdownStreamBlocks(markdown) : null;
  if (!blocks || blocks.length < 2) {
    cache.blocks = new Map();
    return null;
  }
  if (cache.owner !== owner) {
    cache.owner = owner;
    cache.blocks = new Map();
  }
  const previous = cache.blocks;
  const next = new Map<string, BlockEntry>();
  let linkFiles = false;
  let rewritten = false;
  for (const block of blocks) {
    let entry = next.get(block) ?? previous.get(block);
    if (!entry) {
      const parsed = pipeline.parse(block);
      entry = {
        parsed,
        mayLinkFiles: pipeline.mayLinkFiles(parsed),
        renders: [undefined, undefined],
      };
    }
    next.set(block, entry);
    rewritten ||= entry.parsed !== block;
    // The whole text links files when any of its spans looks like a path, so all blocks must.
    linkFiles ||= entry.mayLinkFiles;
  }
  // Rewriting HTML can join or break lines (`<br>`, `<p>`, a removed tag between two backticks),
  // which can open a fence or end a block. The later passes parse the rewritten text, so it has
  // to split at the same places.
  if (rewritten && !splitsAsParsed(blocks.map((block) => next.get(block)!.parsed))) {
    cache.blocks = next;
    return null;
  }
  const parts: string[] = [];
  let fileHrefs: Set<string> | undefined;
  for (const block of blocks) {
    const entry = next.get(block)!;
    const result = (entry.renders[+linkFiles] ??= pipeline.render(entry.parsed, linkFiles));
    parts.push(result.markdown);
    if (result.fileHrefs.size > 0) {
      fileHrefs ??= new Set();
      for (const href of result.fileHrefs) fileHrefs.add(href);
    }
  }
  cache.blocks = next;
  return { markdown: parts.join(""), fileHrefs: fileHrefs ?? new Set() };
}
