import { requireOptionalNativeModule } from "expo";

import { highlightLanguageId } from "./highlightLanguage";
import { HIGHLIGHTS_THEME_STYLES } from "./highlights.generated";

export type HighlightScheme = "light" | "dark";

export interface HighlightedToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export type HighlightedLines = ReadonlyArray<ReadonlyArray<HighlightedToken>>;

const LINE_END = 0xffffffff;
// Longer lines stay one plain token so a minified line does not become
// thousands of native text runs.
const MAX_HIGHLIGHTED_LINE_LENGTH = 1_000;

// @pierre/highlights compiled to native code (modules/t3-highlights). Missing
// from binaries built before it shipped, where code renders as plain text.
const nativeHighlights = requireOptionalNativeModule<{
  tokenize(source: string, language: number): ArrayBuffer | null;
}>("T3Highlights");

function plainLines(code: string): HighlightedLines {
  return code
    .split(/\r?\n/u)
    .map((line) => (line ? [{ content: line, color: null, fontStyle: null }] : []));
}

/**
 * Tokenizes `code` synchronously, one token array per line. Lines split at LF
 * and CRLF, and a trailing line break yields a final empty line.
 */
export function highlightCode(
  code: string,
  language: string,
  scheme: HighlightScheme,
): HighlightedLines {
  const id = highlightLanguageId(language);
  const buffer = id === 0 ? null : (nativeHighlights?.tokenize(code, id) ?? null);
  if (!buffer) return plainLines(code);

  // `(endUtf16, tokenId)` pairs. A LINE_END token ID ends a line, and its end
  // is where the next line starts. Mirrors @pierre/highlights' lineRecordsToTokens.
  const records = new Uint32Array(buffer);
  const styles = HIGHLIGHTS_THEME_STYLES[scheme];
  const lines: HighlightedToken[][] = [];
  let start = 0;
  for (let record = 0; ; record += 2) {
    const first = record;
    while (record < records.length && records[record + 1] !== LINE_END) record += 2;
    const end = record === first ? start : records[record - 2]!;
    if (end - start > MAX_HIGHLIGHTED_LINE_LENGTH) {
      lines.push([{ content: code.slice(start, end), color: null, fontStyle: null }]);
    } else {
      const line: HighlightedToken[] = [];
      for (let at = first; at < record; at += 2) {
        const tokenEnd = records[at]!;
        if (tokenEnd <= start) continue;
        const [color, fontStyle] = styles[records[at + 1]!] ?? styles[0]!;
        line.push({ content: code.slice(start, tokenEnd), color, fontStyle });
        start = tokenEnd;
      }
      lines.push(line);
    }
    if (record >= records.length) break;
    start = records[record]!;
  }
  return lines;
}
