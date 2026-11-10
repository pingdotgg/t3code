import {
  embeddedScripts,
  withEmbeddedScripts,
  type SyntaxToken,
} from "@t3tools/client-runtime/work-log/embedded-scripts";
import type { T3Highlights } from "@t3tools/mobile-highlights-native";
import { NitroModules } from "react-native-nitro-modules";

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
const nativeHighlights = NitroModules.hasHybridObject("T3Highlights")
  ? NitroModules.createHybridObject<T3Highlights>("T3Highlights")
  : undefined;

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

/** Shell commands also color the scripts they embed, such as heredocs and `python -c`. */
export function highlightCommand(
  code: string,
  language: "shellscript" | "powershell",
  scheme: HighlightScheme,
): HighlightedLines {
  const tokenize = (text: string, lang: string) => {
    // A missing grammar keeps the shell colors, as on web.
    if (highlightLanguageId(lang) === 0) throw new Error(`No grammar for ${lang}`);
    return withOffsets(text, highlightCode(text, lang, scheme));
  };
  const embedded = language === "shellscript" ? embeddedScripts(code) : [];
  return withEmbeddedScripts(code, tokenize(code, language), embedded, tokenize).map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

function withOffsets(code: string, lines: HighlightedLines): SyntaxToken[][] {
  const endings = code.match(/\r?\n/gu) ?? [];
  let offset = 0;
  return lines.map((line, index) => {
    const tokens = line.map((token) => {
      const start = offset;
      offset += token.content.length;
      return {
        content: token.content,
        offset: start,
        ...(token.color ? { color: token.color } : {}),
        ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
      };
    });
    offset += endings[index]?.length ?? 0;
    return tokens;
  });
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
