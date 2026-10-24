import { createHighlighterCore, type GrammarState, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bashLanguage from "@shikijs/langs/bash";
import diffLanguage from "@shikijs/langs/diff";
import javascriptLanguage from "@shikijs/langs/javascript";
import jsonLanguage from "@shikijs/langs/json";
import jsxLanguage from "@shikijs/langs/jsx";
import tsxLanguage from "@shikijs/langs/tsx";
import typescriptLanguage from "@shikijs/langs/typescript";
import yamlLanguage from "@shikijs/langs/yaml";
import * as Schema from "effect/Schema";

import type {
  NativeReviewDiffFile,
  NativeReviewDiffLanguage,
  NativeReviewDiffSource,
} from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "./nativeReviewDiffSurface";
import { diffHighlightTraceId, traceDiffHighlight } from "./nativeReviewDiffTrace";

export type NativeReviewDiffHighlightScheme = "light" | "dark";
export type NativeReviewDiffHighlightEngine = "native" | "javascript";

export class NativeReviewDiffHighlighterUnavailableError extends Schema.TaggedError<NativeReviewDiffHighlighterUnavailableError>()(
  "NativeReviewDiffHighlighterUnavailableError",
  {},
) {
  override get message(): string {
    return "The native review diff highlighter is unavailable in this build.";
  }
}

export const isNativeReviewDiffHighlighterUnavailableError = Schema.is(
  NativeReviewDiffHighlighterUnavailableError,
);

export class NativeReviewDiffHighlighterInitializationError extends Schema.TaggedError<NativeReviewDiffHighlighterInitializationError>()(
  "NativeReviewDiffHighlighterInitializationError",
  {
    requestedEngine: Schema.Literals(["native", "javascript"]),
    attemptedEngine: Schema.Literals(["native", "javascript"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the ${this.attemptedEngine} review diff highlighter requested as ${this.requestedEngine}.`;
  }
}

export interface NativeReviewDiffHighlighterHandle {
  readonly engine: NativeReviewDiffHighlightEngine;
  readonly tokenize: (
    code: string,
    options: {
      readonly lang: NativeReviewDiffLanguage;
      readonly theme: string;
      readonly signal?: AbortSignal;
      readonly grammarState?: GrammarState;
      readonly onGrammarState?: (lineCount: number, state: GrammarState | undefined) => void;
    },
  ) => Promise<ReadonlyArray<ReadonlyArray<NativeReviewDiffToken>>>;
}

interface NativeReviewDiffLineRow extends NativeReviewDiffRow {
  readonly kind: "line";
  readonly fileId: string;
  readonly content: string;
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
  readonly onChunk?: (chunk: NativeReviewDiffHighlightChunk) => void;
}

export interface NativeReviewDiffHighlightChunk {
  readonly tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>>;
  readonly retryableRowIds: ReadonlyArray<string>;
  readonly rowCount: number;
  readonly durationMs: number;
}

const NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS = 160;
const NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS = 360;
const NATIVE_REVIEW_DIFF_TOKENIZE_MAX_LINE_LENGTH = 1_000;
const NATIVE_REVIEW_DIFF_TOKENIZE_MAX_CHARACTERS = 8_000;

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

function createHighlighterHandle(
  highlighter: HighlighterCore,
  engine: NativeReviewDiffHighlightEngine,
): NativeReviewDiffHighlighterHandle {
  return {
    engine,
    async tokenize(code, { lang, theme, signal, grammarState, onGrammarState }) {
      const lines = code.split("\n");
      const highlighted: Array<ReadonlyArray<NativeReviewDiffToken>> = [];
      let start = 0;

      while (start < lines.length) {
        if (signal?.aborted) return [];

        // Skipping this line leaves its ending grammar state unknown. Resume
        // from a fresh state rather than leaving the rest of the segment plain:
        // highlighted rows are cached for the sheet's lifetime, so a plain tail
        // would stick, and which rows it covered would depend on where the
        // first visible window happened to start.
        if (lines[start]!.length > NATIVE_REVIEW_DIFF_TOKENIZE_MAX_LINE_LENGTH) {
          highlighted.push([{ content: lines[start] || " ", color: null, fontStyle: null }]);
          grammarState = undefined;
          start += 1;
          onGrammarState?.(start, grammarState);
          continue;
        }

        let end = start;
        let characters = 0;
        while (end < lines.length) {
          const length = lines[end]!.length;
          const nextCharacters = characters + length + (end > start ? 1 : 0);
          if (
            length > NATIVE_REVIEW_DIFF_TOKENIZE_MAX_LINE_LENGTH ||
            nextCharacters > NATIVE_REVIEW_DIFF_TOKENIZE_MAX_CHARACTERS
          ) {
            break;
          }
          characters = nextCharacters;
          end += 1;
        }

        const tokens = highlighter.codeToTokensBase(lines.slice(start, end).join("\n"), {
          lang,
          theme,
          grammarState,
        });
        grammarState = highlighter.getLastGrammarState(tokens);
        highlighted.push(...normalizeTokens(tokens));
        start = end;
        onGrammarState?.(start, grammarState);
        if (start < lines.length) await waitForNextFrame();
      }

      return signal?.aborted ? [] : highlighted;
    },
  };
}

async function createNativeReviewDiffHighlighter(): Promise<NativeReviewDiffHighlighterHandle> {
  const nativeEngineModule = await import("react-native-shiki-engine");
  if (!nativeEngineModule.isNativeEngineAvailable()) {
    throw new NativeReviewDiffHighlighterUnavailableError();
  }

  const highlighter = await createHighlighterCore({
    langs: NATIVE_REVIEW_DIFF_LANGUAGES,
    themes: NATIVE_REVIEW_DIFF_SHIKI_THEMES,
    engine: nativeEngineModule.createNativeEngine(),
  });

  return createHighlighterHandle(highlighter, "native");
}

async function createJavascriptReviewDiffHighlighter(): Promise<NativeReviewDiffHighlighterHandle> {
  const highlighter: HighlighterCore = await createHighlighterCore({
    langs: NATIVE_REVIEW_DIFF_LANGUAGES,
    themes: NATIVE_REVIEW_DIFF_SHIKI_THEMES,
    engine: createJavaScriptRegexEngine(),
  });

  return createHighlighterHandle(highlighter, "javascript");
}

export async function getNativeReviewDiffHighlighter(
  engine: NativeReviewDiffHighlightEngine = "native",
): Promise<NativeReviewDiffHighlighterHandle> {
  if (engine === "javascript") {
    try {
      javascriptHighlighterPromise ??= createJavascriptReviewDiffHighlighter();
      return await javascriptHighlighterPromise;
    } catch (cause) {
      javascriptHighlighterPromise = null;
      throw new NativeReviewDiffHighlighterInitializationError({
        requestedEngine: engine,
        attemptedEngine: "javascript",
        cause,
      });
    }
  }

  nativeHighlighterPromise ??= createNativeReviewDiffHighlighter()
    .catch(async (cause: unknown) => {
      const nativeError = isNativeReviewDiffHighlighterUnavailableError(cause)
        ? cause
        : new NativeReviewDiffHighlighterInitializationError({
            requestedEngine: engine,
            attemptedEngine: "native",
            cause,
          });
      console.warn("[debug-native-diff] native highlighter unavailable", {
        error: nativeError,
      });
      try {
        javascriptHighlighterPromise ??= createJavascriptReviewDiffHighlighter();
        return await javascriptHighlighterPromise;
      } catch (fallbackCause) {
        javascriptHighlighterPromise = null;
        throw new NativeReviewDiffHighlighterInitializationError({
          requestedEngine: engine,
          attemptedEngine: "javascript",
          cause: new AggregateError(
            [nativeError, fallbackCause],
            "Native and JavaScript review diff highlighter initialization failed.",
            { cause: nativeError },
          ),
        });
      }
    })
    .catch((error) => {
      nativeHighlighterPromise = null;
      throw error;
    });
  return await nativeHighlighterPromise;
}

function isHighlightableLineRow(row: NativeReviewDiffRow): row is NativeReviewDiffLineRow {
  return row.kind === "line" && typeof row.fileId === "string" && typeof row.content === "string";
}

function hasConsecutiveLineNumbers(
  previous: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return typeof previous === "number" && typeof next === "number" && next === previous + 1;
}

interface SourceContext {
  readonly lines: ReadonlyArray<string>;
  readonly knownLineCount?: number;
  readonly checkpoints: Map<string, Map<number, GrammarState | undefined>>;
}

const fullSourceContexts = new WeakMap<
  NativeReviewDiffSource,
  { old: FullSourceContext; new: FullSourceContext }
>();

interface FullSourceContext extends SourceContext {
  readonly comparisonLines: ReadonlyArray<string>;
  readonly validation: WeakMap<ReadonlyArray<NativeReviewDiffLineRow>, boolean>;
}

const sourceRowsByFileCache = new WeakMap<
  ReadonlyArray<NativeReviewDiffRow>,
  Map<string, NativeReviewDiffLineRow[]>
>();

function getSourceRowsByFile(rows: ReadonlyArray<NativeReviewDiffRow>) {
  let byFile = sourceRowsByFileCache.get(rows);
  if (!byFile) {
    byFile = new Map();
    for (const row of rows) {
      if (!isHighlightableLineRow(row)) continue;
      const fileRows = byFile.get(row.fileId);
      if (fileRows) fileRows.push(row);
      else byFile.set(row.fileId, [row]);
    }
    sourceRowsByFileCache.set(rows, byFile);
  }
  return byFile;
}

function matchesSourceSide(
  context: FullSourceContext,
  rows: ReadonlyArray<NativeReviewDiffLineRow>,
  side: DiffSide,
) {
  const cached = context.validation.get(rows);
  if (cached !== undefined) return cached;
  // Context participates on both sides, even though it displays NEW tokens.
  // A known mismatch anywhere invalidates grammar from the entire source side.
  const matches = rows.every((row) => {
    if (row.change === (side === "old" ? "add" : "delete")) return true;
    const lineNumber = side === "old" ? row.oldLineNumber : row.newLineNumber;
    return (
      typeof lineNumber === "number" && context.comparisonLines[lineNumber - 1] === row.content
    );
  });
  context.validation.set(rows, matches);
  return matches;
}

function createFullSourceContext(contents: string): FullSourceContext {
  const lines = contents.replace(/\r\n/g, "\n").split("\n");
  const skippedLine = lines.findIndex(
    (line) => line.length > NATIVE_REVIEW_DIFF_TOKENIZE_MAX_LINE_LENGTH,
  );
  return {
    lines,
    // The parser removes LF but retains CR on patch rows. Validate against the
    // same bytes, including a genuine CR at EOF, rather than tokenizer input.
    comparisonLines: contents.split("\n"),
    // Skipping an oversized line makes every subsequent incoming grammar state
    // unknown, even when the rest of the authoritative source is available.
    knownLineCount: skippedLine === -1 ? lines.length : skippedLine,
    checkpoints: new Map(),
    validation: new WeakMap(),
  };
}

function getFullSourceContexts(source: NativeReviewDiffSource) {
  let contexts = fullSourceContexts.get(source);
  if (!contexts) {
    contexts = {
      old: createFullSourceContext(source.oldContents),
      new: createFullSourceContext(source.newContents),
    };
    fullSourceContexts.set(source, contexts);
  }
  return contexts;
}

type DiffSide = "old" | "new";

interface SourceSegment {
  readonly fileId: string;
  readonly side: DiffSide;
  readonly rows: NativeReviewDiffLineRow[];
  readonly checkpoints: Map<string, Map<number, GrammarState | undefined>>;
}

// Row arrays are immutable snapshots. Keep only grammar checkpoints, not a second
// copy of every row's tokens; a sheet release also releases its source context.
const sourceSegmentsCache = new WeakMap<
  ReadonlyArray<NativeReviewDiffRow>,
  Map<string, { readonly segment: SourceSegment; readonly index: number }>
>();

function getSourceSegments(rows: ReadonlyArray<NativeReviewDiffRow>) {
  const cached = sourceSegmentsCache.get(rows);
  if (cached) return cached;

  const segmentsByRowId = new Map<
    string,
    { readonly segment: SourceSegment; readonly index: number }
  >();
  for (const side of ["old", "new"] as const) {
    let segment: SourceSegment | undefined;
    for (const row of rows) {
      if (row.kind === "comment" || row.kind === "hunk") continue;
      if (!isHighlightableLineRow(row)) {
        segment = undefined;
        continue;
      }
      if (row.change === (side === "old" ? "add" : "delete")) continue;

      const previous = segment?.rows.at(-1);
      const lineNumber = side === "old" ? row.oldLineNumber : row.newLineNumber;
      const previousLineNumber = side === "old" ? previous?.oldLineNumber : previous?.newLineNumber;
      if (
        !segment ||
        segment.fileId !== row.fileId ||
        !hasConsecutiveLineNumbers(previousLineNumber, lineNumber)
      ) {
        // A gap has no known incoming grammar state. Highlight the available
        // fragment independently; never join it to an earlier, incomplete hunk.
        segment = { fileId: row.fileId, side, rows: [], checkpoints: new Map() };
      }
      if (displaySide(row) === side) {
        segmentsByRowId.set(row.id, { segment, index: segment.rows.length });
      }
      segment.rows.push(row);
    }
  }
  sourceSegmentsCache.set(rows, segmentsByRowId);
  return segmentsByRowId;
}

function displaySide(row: NativeReviewDiffLineRow): DiffSide {
  // Unified context rows have one token array. Match the NEW side, while OLD
  // context still advances deletion grammar independently.
  return row.change === "delete" ? "old" : "new";
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
  // Deliver plain tokens for these rows without marking them permanently highlighted.
  readonly retryableRowIds: ReadonlyArray<string>;
  readonly rowCount: number;
  readonly durationMs: number;
}> {
  const request = diffHighlightTraceId(input);
  traceDiffHighlight("highlight-start", {
    request,
    first: input.firstRowIndex,
    last: input.lastRowIndex,
    overscan: input.overscanRows ?? NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS,
  });
  const highlighter = await getNativeReviewDiffHighlighter(input.engine ?? "native");
  traceDiffHighlight("highlight-ready", { request, engine: highlighter.engine });
  if (input.signal?.aborted) {
    return {
      engine: highlighter.engine,
      tokensByRowId: {},
      retryableRowIds: [],
      rowCount: 0,
      durationMs: 0,
    };
  }

  const startedAt = performance.now();
  const theme = NATIVE_REVIEW_DIFF_THEME_NAME_BY_SCHEME[input.scheme];
  const fileMap = createFileMap(input.files);
  const overscanRows = input.overscanRows ?? NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS;
  const maxRows = input.maxRows ?? NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS;
  const startIndex = clampRowIndex(input.firstRowIndex - overscanRows, input.rows);
  const endIndex = clampRowIndex(input.lastRowIndex + overscanRows, input.rows);
  const visibleStartIndex = clampRowIndex(input.firstRowIndex, input.rows);
  const visibleEndIndex = clampRowIndex(input.lastRowIndex, input.rows);
  const visibleFileIds = new Set<string>();
  // Overscan warms visible files without loading unrelated neighboring sources.
  // Headers and already-highlighted rows still identify files in the viewport.
  for (let rowIndex = visibleStartIndex; rowIndex <= visibleEndIndex; rowIndex += 1) {
    const fileId = input.rows[rowIndex]?.fileId;
    if (typeof fileId === "string") visibleFileIds.add(fileId);
  }
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
      visibleFileIds.has(row.fileId) &&
      !input.alreadyHighlightedRowIds?.has(row.id) &&
      fileMap.has(row.fileId)
    ) {
      selectedRows.push(row);
    }
  }

  const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
  const retryableRowIds: string[] = [];
  const selectedRowIds = new Set(selectedRows.map((row) => row.id));
  let charactersSinceYield = 0;

  const tokenizeRange = async (
    context: SourceContext,
    firstSelected: number,
    lastSelected: number,
    language: NativeReviewDiffLanguage,
  ) => {
    const checkpointKey = `${highlighter.engine}:${theme}:${language}`;
    let checkpoints = context.checkpoints.get(checkpointKey);
    if (!checkpoints) {
      checkpoints = new Map([[0, undefined]]);
      context.checkpoints.set(checkpointKey, checkpoints);
    }
    let start = 0;
    for (const index of checkpoints.keys()) {
      if (index <= firstSelected && index > start) start = index;
    }
    const code = context.lines.slice(start, lastSelected + 1).join("\n");
    if (
      charactersSinceYield > 0 &&
      charactersSinceYield + code.length > NATIVE_REVIEW_DIFF_TOKENIZE_MAX_CHARACTERS
    ) {
      await waitForNextFrame();
      charactersSinceYield = 0;
    }
    const tokenLines = await highlighter.tokenize(code, {
      lang: language,
      theme,
      signal: input.signal,
      grammarState: checkpoints.get(start),
      onGrammarState: (lineCount, state) => checkpoints.set(start + lineCount, state),
    });
    traceDiffHighlight("tokenized", {
      request,
      start,
      lastSelected,
      characters: code.length,
      lines: tokenLines.length,
      aborted: input.signal?.aborted ?? false,
    });
    charactersSinceYield += code.length;
    return { tokenLines, start };
  };

  const sourceFiles = new Map<string, NativeReviewDiffLineRow[]>();
  for (const row of selectedRows) {
    if (!fileMap.get(row.fileId)?.loadContents) continue;
    const fileRows = sourceFiles.get(row.fileId);
    if (fileRows) fileRows.push(row);
    else sourceFiles.set(row.fileId, [row]);
  }
  const emitFileChunk = (fileRows: ReadonlyArray<NativeReviewDiffLineRow>) => {
    if (!input.onChunk || input.signal?.aborted) return;
    const rowIds = new Set(fileRows.map((row) => row.id));
    input.onChunk({
      tokensByRowId: Object.fromEntries(fileRows.map((row) => [row.id, tokensByRowId[row.id]!])),
      retryableRowIds: retryableRowIds.filter((id) => rowIds.has(id)),
      rowCount: fileRows.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
  };
  // The file filling the viewport should not wait for a sliver of its neighbor.
  for (const [fileId, fileRows] of [...sourceFiles].sort((a, b) => b[1].length - a[1].length)) {
    if (input.signal?.aborted) break;
    const file = fileMap.get(fileId)!;
    const fileTraceId = diffHighlightTraceId(fileId);
    traceDiffHighlight("highlight-source", { request, file: fileTraceId, rows: fileRows.length });
    let source: NativeReviewDiffSource | null;
    try {
      source = await file.loadContents!(input.signal);
    } catch {
      traceDiffHighlight("highlight-source-error", { request, file: fileTraceId });
      for (const row of fileRows) {
        selectedRowIds.delete(row.id);
        tokensByRowId[row.id] = makePlainTokenFallback(row);
        retryableRowIds.push(row.id);
      }
      emitFileChunk(fileRows);
      continue;
    }
    if (input.signal?.aborted) break;
    const contexts = source ? getFullSourceContexts(source) : null;
    for (const side of ["old", "new"] as const) {
      const candidate = contexts?.[side];
      const context =
        candidate &&
        matchesSourceSide(candidate, getSourceRowsByFile(input.rows).get(fileId)!, side)
          ? candidate
          : null;
      traceDiffHighlight("source-validation", {
        request,
        file: fileTraceId,
        side,
        present: !!candidate,
        matches: !!context,
        knownLines: context?.knownLineCount,
      });
      const matchingRows: { row: NativeReviewDiffLineRow; lineIndex: number }[] = [];
      for (const row of fileRows) {
        if (displaySide(row) !== side) continue;
        selectedRowIds.delete(row.id);
        const lineNumber = side === "old" ? row.oldLineNumber : row.newLineNumber;
        const lineIndex = typeof lineNumber === "number" ? lineNumber - 1 : -1;
        if (
          context &&
          lineIndex >= 0 &&
          lineIndex < (context.knownLineCount ?? context.lines.length) &&
          context.comparisonLines[lineIndex] === row.content
        ) {
          matchingRows.push({ row, lineIndex });
        } else {
          // A changed revision, missing source, or exceeded source budget cannot
          // supply trustworthy grammar. Do not cache guessed syntax colors.
          tokensByRowId[row.id] = makePlainTokenFallback(row);
        }
      }
      if (!context || matchingRows.length === 0) continue;
      const { tokenLines, start } = await tokenizeRange(
        context,
        matchingRows[0]!.lineIndex,
        matchingRows.at(-1)!.lineIndex,
        file.language,
      );
      for (const { row, lineIndex } of matchingRows) {
        tokensByRowId[row.id] = tokenLines[lineIndex - start] ?? makePlainTokenFallback(row);
      }
    }
    emitFileChunk(fileRows);
  }

  const selectedSegments = new Map<
    SourceSegment,
    { firstSelected: number; lastSelected: number }
  >();
  if (selectedRowIds.size > 0 && !input.signal?.aborted) {
    const sourceSegments = getSourceSegments(input.rows);
    for (const row of selectedRows) {
      if (!selectedRowIds.has(row.id)) continue;
      const source = sourceSegments.get(row.id);
      if (!source) continue;
      const selection = selectedSegments.get(source.segment);
      if (selection) {
        selection.lastSelected = source.index;
      } else {
        selectedSegments.set(source.segment, {
          firstSelected: source.index,
          lastSelected: source.index,
        });
      }
    }
  }

  for (const [segment, { firstSelected, lastSelected }] of selectedSegments) {
    if (input.signal?.aborted) break;
    const file = fileMap.get(segment.fileId);
    if (!file) continue;

    const { tokenLines, start } = await tokenizeRange(
      { lines: segment.rows.map((row) => row.content), checkpoints: segment.checkpoints },
      firstSelected,
      lastSelected,
      file.language,
    );
    for (let index = firstSelected; index <= lastSelected; index += 1) {
      const row = segment.rows[index]!;
      if (selectedRowIds.has(row.id) && displaySide(row) === segment.side) {
        tokensByRowId[row.id] = tokenLines[index - start] ?? makePlainTokenFallback(row);
      }
    }
  }

  if (input.signal?.aborted) {
    traceDiffHighlight("highlight-aborted", { request });
    return {
      engine: highlighter.engine,
      tokensByRowId: {},
      retryableRowIds: [],
      rowCount: 0,
      durationMs: 0,
    };
  }

  traceDiffHighlight("highlight-result", {
    request,
    selected: selectedRows.length,
    delivered: Object.keys(tokensByRowId).length,
    retryable: retryableRowIds.length,
    colored: Object.values(tokensByRowId).filter((tokens) =>
      tokens.some((token) => token.color !== null),
    ).length,
  });
  return {
    engine: highlighter.engine,
    tokensByRowId,
    retryableRowIds,
    rowCount: selectedRows.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
