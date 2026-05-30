import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bashLanguage from "@shikijs/langs/bash";
import diffLanguage from "@shikijs/langs/diff";
import javascriptLanguage from "@shikijs/langs/javascript";
import jsonLanguage from "@shikijs/langs/json";
import jsxLanguage from "@shikijs/langs/jsx";
import tsxLanguage from "@shikijs/langs/tsx";
import typescriptLanguage from "@shikijs/langs/typescript";
import yamlLanguage from "@shikijs/langs/yaml";

import type { NativeReviewDiffFile, NativeReviewDiffLanguage } from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "./nativeReviewDiffSurface";

export type NativeReviewDiffHighlightScheme = "light" | "dark";
export type NativeReviewDiffHighlightEngine = "native" | "javascript";

export interface NativeReviewDiffHighlighterHandle {
  readonly engine: NativeReviewDiffHighlightEngine;
  readonly tokenize: (
    code: string,
    options: { readonly lang: NativeReviewDiffLanguage; readonly theme: string },
  ) => ReadonlyArray<ReadonlyArray<NativeReviewDiffToken>>;
}

interface NativeReviewDiffLineRow extends NativeReviewDiffRow {
  readonly kind: "line";
  readonly fileId: string;
  readonly content: string;
}

export interface NativeReviewDiffTokenChunk {
  readonly chunkIndex: number;
  readonly fileId: string;
  readonly filePath: string;
  readonly language: NativeReviewDiffLanguage;
  readonly lineCount: number;
  readonly durationMs: number;
  readonly tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>>;
}

export interface StreamNativeReviewDiffTokenInput {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly engine?: NativeReviewDiffHighlightEngine;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
  readonly onChunk: (chunk: NativeReviewDiffTokenChunk) => void;
}

export interface HighlightNativeReviewDiffVisibleRowsInput {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly engine?: NativeReviewDiffHighlightEngine;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
  readonly overscanRows?: number;
  readonly maxRows?: number;
  readonly alreadyHighlightedRowIds?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

const NATIVE_REVIEW_DIFF_HIGHLIGHT_CHUNK_SIZE = 500;
const NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS = 160;
const NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS = 360;

const NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME = {
  dark: "t3-pierre-dark",
  light: "t3-pierre-light",
} as const;

const PIERRE_LIGHT_SHIKI_THEME = {
  name: NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME.light,
  type: "light" as const,
  fg: "#070707",
  bg: "#ffffff",
  settings: [
    { settings: { foreground: "#070707", background: "#ffffff" } },
    { scope: "comment, punctuation.definition.comment", settings: { foreground: "#84848A" } },
    {
      scope: "keyword, storage, storage.type, keyword.operator.expression",
      settings: { foreground: "#FC2B73" },
    },
    {
      scope: "entity.name.function, support.function, meta.function-call",
      settings: { foreground: "#7B43F8" },
    },
    {
      scope: "entity.name.type, support.type, support.class",
      settings: { foreground: "#C635E4" },
    },
    {
      scope: "string, constant.character, punctuation.definition.string",
      settings: { foreground: "#199F43" },
    },
    {
      scope: "constant.numeric, constant.language, constant.other",
      settings: { foreground: "#1CA1C7" },
    },
    {
      scope: "variable.parameter, variable.other.readwrite, meta.object-literal.key",
      settings: { foreground: "#D47628" },
    },
    {
      scope: "entity.name.tag, support.class.component",
      settings: { foreground: "#199F43" },
    },
    {
      scope: "punctuation, meta.brace, meta.delimiter",
      settings: { foreground: "#79797F" },
    },
    { scope: "invalid", settings: { foreground: "#D52C36" } },
  ],
};

const PIERRE_DARK_SHIKI_THEME = {
  name: NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME.dark,
  type: "dark" as const,
  fg: "#adadb1",
  bg: "#0a0a0a",
  settings: [
    { settings: { foreground: "#adadb1", background: "#0a0a0a" } },
    { scope: "comment, punctuation.definition.comment", settings: { foreground: "#84848A" } },
    {
      scope: "keyword, storage, storage.type, keyword.operator.expression",
      settings: { foreground: "#FF678D" },
    },
    {
      scope: "entity.name.function, support.function, meta.function-call",
      settings: { foreground: "#9D6AFB" },
    },
    {
      scope: "entity.name.type, support.type, support.class",
      settings: { foreground: "#D568EA" },
    },
    {
      scope: "string, constant.character, punctuation.definition.string",
      settings: { foreground: "#5ECC71" },
    },
    {
      scope: "constant.numeric, constant.language, constant.other",
      settings: { foreground: "#68CDF2" },
    },
    {
      scope: "variable.parameter, variable.other.readwrite, meta.object-literal.key",
      settings: { foreground: "#FFA359" },
    },
    {
      scope: "entity.name.tag, support.class.component",
      settings: { foreground: "#5ECC71" },
    },
    {
      scope: "punctuation, meta.brace, meta.delimiter",
      settings: { foreground: "#79797F" },
    },
    { scope: "invalid", settings: { foreground: "#FF6762" } },
  ],
};

const NATIVE_REVIEW_DIFF_SHIKI_THEMES = [
  PIERRE_LIGHT_SHIKI_THEME,
  PIERRE_DARK_SHIKI_THEME,
] satisfies Parameters<typeof createHighlighterCore>[0]["themes"];

const NATIVE_REVIEW_DIFF_LANGUAGES = [
  bashLanguage,
  diffLanguage,
  javascriptLanguage,
  jsonLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
  yamlLanguage,
] satisfies Parameters<typeof createHighlighterCore>[0]["langs"];

let nativeHighlighterPromise: Promise<NativeReviewDiffHighlighterHandle> | null = null;
let javascriptHighlighterPromise: Promise<NativeReviewDiffHighlighterHandle> | null = null;

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeTokens(
  tokenLines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string; fontStyle?: number }>>,
): ReadonlyArray<ReadonlyArray<NativeReviewDiffToken>> {
  return tokenLines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

async function createNativeReviewDiffHighlighter(): Promise<NativeReviewDiffHighlighterHandle> {
  const nativeEngineModule = await import("react-native-shiki-engine");
  if (!nativeEngineModule.isNativeEngineAvailable()) {
    throw new Error("Native Shiki engine is not available in this build.");
  }

  const highlighter = await createHighlighterCore({
    langs: NATIVE_REVIEW_DIFF_LANGUAGES,
    themes: NATIVE_REVIEW_DIFF_SHIKI_THEMES,
    engine: nativeEngineModule.createNativeEngine(),
  });

  return {
    engine: "native",
    tokenize: (code, options) => normalizeTokens(highlighter.codeToTokensBase(code, options)),
  };
}

async function createJavascriptReviewDiffHighlighter(): Promise<NativeReviewDiffHighlighterHandle> {
  const highlighter: HighlighterCore = await createHighlighterCore({
    langs: NATIVE_REVIEW_DIFF_LANGUAGES,
    themes: NATIVE_REVIEW_DIFF_SHIKI_THEMES,
    engine: createJavaScriptRegexEngine(),
  });

  return {
    engine: "javascript",
    tokenize: (code, options) => normalizeTokens(highlighter.codeToTokensBase(code, options)),
  };
}

export async function getNativeReviewDiffHighlighter(
  engine: NativeReviewDiffHighlightEngine = "native",
): Promise<NativeReviewDiffHighlighterHandle> {
  if (engine === "javascript") {
    javascriptHighlighterPromise ??= createJavascriptReviewDiffHighlighter();
    return javascriptHighlighterPromise;
  }

  nativeHighlighterPromise ??= createNativeReviewDiffHighlighter().catch((error: unknown) => {
    console.warn("[debug-native-diff] native highlighter unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    javascriptHighlighterPromise ??= createJavascriptReviewDiffHighlighter();
    return javascriptHighlighterPromise;
  });
  return nativeHighlighterPromise;
}

function isHighlightableLineRow(row: NativeReviewDiffRow): row is NativeReviewDiffLineRow {
  return row.kind === "line" && typeof row.fileId === "string" && typeof row.content === "string";
}

function groupLineRowsByFileId(rows: ReadonlyArray<NativeReviewDiffRow>) {
  const rowsByFileId = new Map<string, NativeReviewDiffLineRow[]>();
  for (const row of rows) {
    if (!isHighlightableLineRow(row)) {
      continue;
    }

    const fileRows = rowsByFileId.get(row.fileId) ?? [];
    fileRows.push(row);
    rowsByFileId.set(row.fileId, fileRows);
  }
  return rowsByFileId;
}

function createFileMap(files: ReadonlyArray<NativeReviewDiffFile>) {
  return new Map(files.map((file) => [file.id, file]));
}

function clampRowIndex(index: number, rows: ReadonlyArray<NativeReviewDiffRow>) {
  if (rows.length === 0) {
    return 0;
  }

  return Math.min(rows.length - 1, Math.max(0, Math.floor(index)));
}

function makePlainTokenFallback(
  row: NativeReviewDiffLineRow,
): ReadonlyArray<NativeReviewDiffToken> {
  return [{ content: row.content || " ", color: null, fontStyle: null }];
}

export async function highlightNativeReviewDiffVisibleRows(
  input: HighlightNativeReviewDiffVisibleRowsInput,
): Promise<{
  readonly engine: NativeReviewDiffHighlightEngine;
  readonly tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>>;
  readonly rowCount: number;
  readonly durationMs: number;
}> {
  const highlighter = await getNativeReviewDiffHighlighter(input.engine ?? "native");
  if (input.signal?.aborted) {
    return { engine: highlighter.engine, tokensByRowId: {}, rowCount: 0, durationMs: 0 };
  }

  const startedAt = performance.now();
  const theme = NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME[input.scheme];
  const fileMap = createFileMap(input.files);
  const overscanRows = input.overscanRows ?? NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS;
  const maxRows = input.maxRows ?? NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS;
  const startIndex = clampRowIndex(input.firstRowIndex - overscanRows, input.rows);
  const endIndex = clampRowIndex(input.lastRowIndex + overscanRows, input.rows);
  const selectedRows: NativeReviewDiffLineRow[] = [];

  for (
    let rowIndex = startIndex;
    rowIndex <= endIndex && selectedRows.length < maxRows;
    rowIndex += 1
  ) {
    const row = input.rows[rowIndex];
    if (
      row &&
      isHighlightableLineRow(row) &&
      !input.alreadyHighlightedRowIds?.has(row.id) &&
      fileMap.has(row.fileId)
    ) {
      selectedRows.push(row);
    }
  }

  const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
  let segmentRows: NativeReviewDiffLineRow[] = [];
  let segmentFile: NativeReviewDiffFile | undefined;

  const flushSegment = () => {
    if (!segmentFile || segmentRows.length === 0 || input.signal?.aborted) {
      segmentRows = [];
      segmentFile = undefined;
      return;
    }

    const code = segmentRows.map((row) => row.content).join("\n");
    const tokenLines = highlighter.tokenize(code, { lang: segmentFile.language, theme });
    segmentRows.forEach((row, rowIndex) => {
      tokensByRowId[row.id] = tokenLines[rowIndex] ?? makePlainTokenFallback(row);
    });
    segmentRows = [];
    segmentFile = undefined;
  };

  for (const row of selectedRows) {
    const file = fileMap.get(row.fileId);
    if (!file) {
      continue;
    }

    if (segmentFile && segmentFile.id !== file.id) {
      flushSegment();
    }

    segmentFile = file;
    segmentRows.push(row);
  }
  flushSegment();

  return {
    engine: highlighter.engine,
    tokensByRowId,
    rowCount: selectedRows.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export async function streamNativeReviewDiffTokens(
  input: StreamNativeReviewDiffTokenInput,
): Promise<NativeReviewDiffHighlightEngine> {
  const highlighter = await getNativeReviewDiffHighlighter(input.engine ?? "native");
  const rowsByFileId = groupLineRowsByFileId(input.rows);
  const theme = NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME[input.scheme];
  const chunkSize = input.chunkSize ?? NATIVE_REVIEW_DIFF_HIGHLIGHT_CHUNK_SIZE;
  let chunkIndex = 0;

  for (const file of input.files) {
    const fileRows = rowsByFileId.get(file.id) ?? [];
    for (let startIndex = 0; startIndex < fileRows.length; startIndex += chunkSize) {
      if (input.signal?.aborted) {
        return highlighter.engine;
      }

      const startedAt = performance.now();
      const chunkRows = fileRows.slice(startIndex, startIndex + chunkSize);
      const code = chunkRows.map((row) => row.content).join("\n");
      const tokenLines = highlighter.tokenize(code, { lang: file.language, theme });
      const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};

      chunkRows.forEach((row, rowIndex) => {
        tokensByRowId[row.id] = tokenLines[rowIndex] ?? makePlainTokenFallback(row);
      });

      input.onChunk({
        chunkIndex,
        fileId: file.id,
        filePath: file.path,
        language: file.language,
        lineCount: chunkRows.length,
        durationMs: Math.round(performance.now() - startedAt),
        tokensByRowId,
      });

      chunkIndex += 1;
      await waitForNextFrame();
    }
  }

  return highlighter.engine;
}
