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

export interface TokenizedCode {
  /** Retained UTF-16 source, compact native records, and line indexes. */
  readonly byteLength: number;
  readonly lineCount: number;
  readonly highlightLine: (
    index: number,
    scheme: HighlightScheme,
  ) => ReadonlyArray<HighlightedToken> | undefined;
}

/** Keep native records compact; expand only lines a client will display. */
export function tokenizeCode(code: string, language: string): TokenizedCode {
  const id = highlightLanguageId(language);
  const buffer = id === 0 ? null : (nativeHighlights?.tokenize(code, id) ?? null);
  const records = buffer ? new Uint32Array(buffer) : null;
  const offsets = [0];
  if (records) {
    for (let record = 0; record < records.length; record += 2) {
      if (records[record + 1] === LINE_END) offsets.push(record + 2);
    }
  } else {
    for (let at = code.indexOf("\n"); at !== -1; at = code.indexOf("\n", at + 1))
      offsets.push(at + 1);
  }
  const lineStarts = Uint32Array.from(offsets);
  return {
    byteLength: code.length * 2 + (records?.byteLength ?? 0) + lineStarts.byteLength,
    lineCount: lineStarts.length,
    highlightLine(index, scheme) {
      if (index < 0 || index >= lineStarts.length) return undefined;
      const first = lineStarts[index]!;
      const next = lineStarts[index + 1];
      if (!records) {
        const end = next === undefined ? code.length : next - (code[next - 2] === "\r" ? 2 : 1);
        const content = code.slice(first, end);
        return content ? [{ content, color: null, fontStyle: null }] : [];
      }
      let start = first === 0 ? 0 : records[first - 2]!;
      const last = next === undefined ? records.length : next - 2;
      const end = last === first ? start : records[last - 2]!;
      if (end - start > MAX_HIGHLIGHTED_LINE_LENGTH) {
        return [{ content: code.slice(start, end), color: null, fontStyle: null }];
      }
      const styles = HIGHLIGHTS_THEME_STYLES[scheme];
      const line: HighlightedToken[] = [];
      for (let at = first; at < last; at += 2) {
        const tokenEnd = records[at]!;
        if (tokenEnd <= start) continue;
        const [color, fontStyle] = styles[records[at + 1]!] ?? styles[0]!;
        line.push({ content: code.slice(start, tokenEnd), color, fontStyle });
        start = tokenEnd;
      }
      return line;
    },
  };
}

/** LF and CRLF split lines; a trailing line break yields a final empty line. */
export function highlightCode(
  code: string,
  language: string,
  scheme: HighlightScheme,
): HighlightedLines {
  const source = tokenizeCode(code, language);
  return Array.from({ length: source.lineCount }, (_, index) =>
    source.highlightLine(index, scheme)!,
  );
}
