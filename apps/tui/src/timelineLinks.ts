import { extractTerminalLinks } from "@t3tools/shared/terminalLinks";

/** Match the terminal link payload bound and avoid rescanning pathological messages. */
const TIMELINE_LINK_MAX_CHARS = 4 * 1024;
const TIMELINE_LINK_SCAN_MAX_CHARS = 256 * 1024;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/;
const REFERENCE_DEFINITION_PATTERN = /^[ \t]{0,3}\[[^\]]+\]:/;

interface Range {
  readonly start: number;
  readonly end: number;
}

function overlaps(range: Range, other: Range): boolean {
  return range.start < other.end && other.start < range.end;
}

/** Markdown regions where introducing an autolink would change existing syntax. */
function protectedInlineRanges(line: string): ReadonlyArray<Range> {
  const ranges: Range[] = [];

  // Inline code spans use matching runs of backticks. Protect the complete span,
  // including its delimiters, but leave unmatched backticks as ordinary text.
  for (let start = 0; start < line.length; ) {
    if (line[start] !== "`") {
      start += 1;
      continue;
    }
    let runEnd = start + 1;
    while (line[runEnd] === "`") runEnd += 1;
    const delimiter = line.slice(start, runEnd);
    const close = line.indexOf(delimiter, runEnd);
    if (close < 0) {
      start = runEnd;
      continue;
    }
    ranges.push({ start, end: close + delimiter.length });
    start = close + delimiter.length;
  }

  // Existing autolinks and HTML tags already own everything between < and >.
  for (const match of line.matchAll(/<[^>\n]*>/g)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  // Protect complete inline Markdown links/images so a URL used as the label or
  // destination never becomes a nested autolink.
  for (const match of line.matchAll(/!?\[[^\]\n]*\]\([^\n)]*\)/g)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of line.matchAll(/\[[^\]\n]*\]/g)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  return ranges;
}

function linkifyLine(line: string): string {
  if (REFERENCE_DEFINITION_PATTERN.test(line)) return line;
  const protectedRanges = protectedInlineRanges(line);
  const matches = extractTerminalLinks(line).filter(
    (match) =>
      match.kind === "url" &&
      match.text.length <= TIMELINE_LINK_MAX_CHARS &&
      !protectedRanges.some((range) => overlaps(match, range)),
  );
  if (matches.length === 0) return line;

  let result = line;
  for (const match of matches.toReversed()) {
    result = `${result.slice(0, match.start)}<${match.text}>${result.slice(match.end)}`;
  }
  return result;
}

/**
 * Turn bare HTTP(S) text into explicit Markdown autolinks so OpenTUI emits OSC 8
 * hyperlinks in the conversation timeline, just as the xterm-backed drawer does.
 * Code and existing Markdown link syntax remain byte-for-byte unchanged.
 */
export function linkifyTimelineUrls(markdown: string): string {
  if (markdown.length === 0 || markdown.length > TIMELINE_LINK_SCAN_MAX_CHARS) return markdown;

  let fence: { readonly marker: "`" | "~"; readonly length: number } | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(FENCE_PATTERN);
      if (fence) {
        if (fenceMatch?.[1]) {
          const run = fenceMatch[1];
          const marker = run[0] as "`" | "~";
          const trailing = line.slice((fenceMatch.index ?? 0) + fenceMatch[0].length);
          if (
            marker === fence.marker &&
            run.length >= fence.length &&
            trailing.trim().length === 0
          ) {
            fence = null;
          }
        }
        return line;
      }
      if (fenceMatch?.[1]) {
        const run = fenceMatch[1];
        const marker = run[0] as "`" | "~";
        fence = { marker, length: run.length };
        return line;
      }
      if (INDENTED_CODE_PATTERN.test(line)) return line;
      return linkifyLine(line);
    })
    .join("\n");
}
