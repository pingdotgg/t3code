/**
 * CommonMark reads a backslash before ASCII punctuation as an escape, even
 * inside a link or image destination. Agents write Windows paths with their
 * native separator, so `C:\Users\dara\.t3\shot.png` parses as
 * `C:\Users\dara.t3\shot.png` and the asset request asks for a file that does
 * not exist. Rewriting the separators to `/` before parsing keeps every
 * character in place: the path is still absolute, the parser has nothing to
 * unescape, and the text keeps its length so source offsets stay valid.
 */

const WINDOWS_DRIVE_DESTINATION_PATTERN = /\]\(\s*(?:<([A-Za-z]:\\[^>\n]*)>|([A-Za-z]:\\[^\s)]*))/g;
const INLINE_CODE_PATTERN = /(`+)[^`][\s\S]*?\1(?!`)/g;
const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

function normalizeDestinations(segment: string): string {
  if (!segment.includes(":\\")) return segment;
  return segment.replace(
    WINDOWS_DRIVE_DESTINATION_PATTERN,
    (match, angle?: string, bare?: string) => {
      const destination = angle ?? bare;
      if (destination === undefined) return match;
      const normalized = destination.replaceAll("\\", "/");
      return angle === undefined
        ? match.slice(0, match.length - destination.length) + normalized
        : match.slice(0, match.length - destination.length - 1) + normalized + ">";
    },
  );
}

function normalizeOutsideInlineCode(segment: string): string {
  let result = "";
  let cursor = 0;
  for (const match of segment.matchAll(INLINE_CODE_PATTERN)) {
    result += normalizeDestinations(segment.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + normalizeDestinations(segment.slice(cursor));
}

/**
 * Rewrites Windows drive-letter link and image destinations to forward slashes
 * so backslash escapes cannot corrupt the path during parsing. Code spans and
 * fenced code blocks are left as written. The result has the same length as
 * the input.
 */
export function normalizeWindowsMarkdownDestinations(markdown: string): string {
  if (!markdown.includes(":\\")) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let openFence: string | null = null;

  const flushProse = () => {
    if (prose.length === 0) return;
    output.push(normalizeOutsideInlineCode(prose.join("\n")));
    prose = [];
  };

  for (const line of lines) {
    const fence = CODE_FENCE_PATTERN.exec(line)?.[1];
    if (openFence === null) {
      if (fence !== undefined) {
        flushProse();
        openFence = fence;
        output.push(line);
      } else {
        prose.push(line);
      }
      continue;
    }
    output.push(line);
    if (
      fence !== undefined &&
      fence[0] === openFence[0] &&
      fence.length >= openFence.length &&
      line.trim() === fence
    ) {
      openFence = null;
    }
  }
  flushProse();
  return output.join("\n");
}
