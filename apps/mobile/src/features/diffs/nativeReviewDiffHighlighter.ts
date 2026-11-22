import { tokenizeCode, type HighlightScheme, type TokenizedCode } from "../../lib/highlights";
import type { NativeReviewDiffFile, NativeReviewDiffSource } from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "./nativeReviewDiffSurface";
import { diffHighlightTraceId, traceDiffHighlight } from "./nativeReviewDiffTrace";

interface NativeReviewDiffLineRow extends NativeReviewDiffRow {
  readonly kind: "line";
  readonly fileId: string;
  readonly content: string;
}

export interface HighlightNativeReviewDiffVisibleRowsInput {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly scheme: HighlightScheme;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
  readonly overscanRows?: number;
  readonly maxRows?: number;
  readonly alreadyHighlightedRowIds?: ReadonlySet<string>;
  readonly collapsedFileIds?: ReadonlySet<string>;
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
function isHighlightableLineRow(row: NativeReviewDiffRow): row is NativeReviewDiffLineRow {
  return row.kind === "line" && typeof row.fileId === "string" && typeof row.content === "string";
}

function hasConsecutiveLineNumbers(
  previous: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return typeof previous === "number" && typeof next === "number" && next === previous + 1;
}

// Native lexing is non-incremental. Cache theme-independent raw records, never
// expanded token objects for an entire large file. Bound both entry count and bytes.
const MAX_TOKEN_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_TOKEN_CACHE_ENTRIES = 8;
// LRU entries own only token data; source contexts and diff rows can collect independently.
const tokenCacheKeys = new WeakMap<object, object>();
const tokenCache = new Map<object, { language: string; tokens: TokenizedCode }>();
let tokenCacheBytes = 0;

function getTokenCacheKey(context: object): object {
  let key = tokenCacheKeys.get(context);
  if (!key) {
    key = {};
    tokenCacheKeys.set(context, key);
  }
  return key;
}

function getCachedTokens(
  cacheKey: object,
  contents: string | (() => string),
  language: string,
): TokenizedCode {
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    tokenCache.delete(cacheKey);
    tokenCacheBytes -= cached.tokens.byteLength;
    if (cached.language === language) {
      tokenCache.set(cacheKey, cached);
      tokenCacheBytes += cached.tokens.byteLength;
      return cached.tokens;
    }
  }
  const tokens = tokenizeCode(typeof contents === "string" ? contents : contents(), language);
  if (tokens.byteLength <= MAX_TOKEN_CACHE_BYTES) {
    tokenCache.set(cacheKey, { language, tokens });
    tokenCacheBytes += tokens.byteLength;
  }
  while (tokenCacheBytes > MAX_TOKEN_CACHE_BYTES || tokenCache.size > MAX_TOKEN_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value!;
    tokenCacheBytes -= tokenCache.get(oldest)!.tokens.byteLength;
    tokenCache.delete(oldest);
  }
  return tokens;
}

const fullSourceContexts = new WeakMap<
  NativeReviewDiffSource,
  { old: FullSourceContext; new: FullSourceContext }
>();

interface FullSourceContext {
  readonly contents: string;
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
  return {
    contents,
    // The diff parser retains CR on patch rows, unlike the token output.
    comparisonLines: contents.split("\n"),
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
}

// Row arrays are immutable snapshots; comments and hidden hunks retain source context.
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
        segment = { fileId: row.fileId, side, rows: [] };
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

function settlesWithinTask(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);
}

export async function highlightNativeReviewDiffVisibleRows(
  input: HighlightNativeReviewDiffVisibleRowsInput,
): Promise<{
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
  if (input.signal?.aborted) {
    return {
      tokensByRowId: {},
      retryableRowIds: [],
      rowCount: 0,
      durationMs: 0,
    };
  }

  const startedAt = performance.now();
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
      !input.collapsedFileIds?.has(row.fileId) &&
      !input.alreadyHighlightedRowIds?.has(row.id) &&
      fileMap.has(row.fileId)
    ) {
      selectedRows.push(row);
    }
  }

  const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
  const retryableRowIds: string[] = [];
  const selectedRowIds = new Set(selectedRows.map((row) => row.id));
  const tokenize = (context: object, contents: string | (() => string), language: string) => {
    const cacheKey = getTokenCacheKey(context);
    const cacheHit = tokenCache.get(cacheKey)?.language === language;
    const cached = getCachedTokens(cacheKey, contents, language);
    traceDiffHighlight("tokenized", {
      request,
      characters: typeof contents === "string" ? contents.length : undefined,
      cacheHit,
      retainedBytes: cached.byteLength,
      lines: cached.lineCount,
      aborted: input.signal?.aborted ?? false,
    });
    return cached;
  };

  // Patch-only grammar: each run of consecutive lines is tokenized on its own.
  const highlightSegmentRows = (
    rowIds: ReadonlySet<string>,
    out: Record<string, ReadonlyArray<NativeReviewDiffToken>>,
  ) => {
    const sourceSegments = getSourceSegments(input.rows);
    const selectedSegments = new Map<
      SourceSegment,
      { firstSelected: number; lastSelected: number }
    >();
    for (const row of selectedRows) {
      if (!rowIds.has(row.id)) continue;
      const source = sourceSegments.get(row.id);
      if (!source) continue;
      const selection = selectedSegments.get(source.segment);
      if (selection) selection.lastSelected = source.index;
      else
        selectedSegments.set(source.segment, {
          firstSelected: source.index,
          lastSelected: source.index,
        });
    }
    for (const [segment, { firstSelected, lastSelected }] of selectedSegments) {
      if (input.signal?.aborted) return;
      const file = fileMap.get(segment.fileId);
      if (!file) continue;
      const tokens = tokenize(
        segment,
        () => segment.rows.map((row) => row.content).join("\n"),
        file.language,
      );
      for (let index = firstSelected; index <= lastSelected; index += 1) {
        const row = segment.rows[index]!;
        if (rowIds.has(row.id) && displaySide(row) === segment.side) {
          out[row.id] = tokens.highlightLine(index, input.scheme) ?? makePlainTokenFallback(row);
        }
      }
    }
  };

  const sourceFiles = new Map<string, NativeReviewDiffLineRow[]>();
  for (const row of selectedRows) {
    if (!fileMap.get(row.fileId)?.loadContents) continue;
    const fileRows = sourceFiles.get(row.fileId);
    if (fileRows) fileRows.push(row);
    else sourceFiles.set(row.fileId, [row]);
  }
  const emitChunk = (
    chunkTokens: Record<string, ReadonlyArray<NativeReviewDiffToken>>,
    chunkRetryableRowIds: ReadonlyArray<string>,
  ) => {
    const rowCount = Object.keys(chunkTokens).length;
    if (!input.onChunk || input.signal?.aborted || rowCount === 0) return;
    input.onChunk({
      tokensByRowId: chunkTokens,
      retryableRowIds: chunkRetryableRowIds,
      rowCount,
      durationMs: Math.round(performance.now() - startedAt),
    });
  };
  // Full sources arrive over the network. Until they do, show patch-only colors
  // as retryable rows, which the full-source tokens then replace.
  const emitProvisionalChunk = (rows: ReadonlyArray<NativeReviewDiffLineRow>) => {
    if (!input.onChunk) return;
    const provisional: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
    highlightSegmentRows(new Set(rows.map((row) => row.id)), provisional);
    traceDiffHighlight("highlight-provisional", { request, rows: rows.length });
    emitChunk(provisional, Object.keys(provisional));
  };
  // The file filling the viewport should not wait for a sliver of its neighbor.
  const sourceEntries = [...sourceFiles].sort((a, b) => b[1].length - a[1].length);
  let provisionalFrom = sourceEntries.length;
  for (const [entryIndex, [fileId, fileRows]] of sourceEntries.entries()) {
    if (input.signal?.aborted) break;
    const file = fileMap.get(fileId)!;
    const fileTraceId = diffHighlightTraceId(fileId);
    traceDiffHighlight("highlight-source", { request, file: fileTraceId, rows: fileRows.length });
    const loading = file.loadContents!(input.signal);
    if (entryIndex < provisionalFrom && !(await settlesWithinTask(loading))) {
      if (input.signal?.aborted) break;
      provisionalFrom = entryIndex;
      emitProvisionalChunk(sourceEntries.slice(entryIndex).flatMap(([, rows]) => rows));
    }
    let source: NativeReviewDiffSource | null;
    try {
      source = await loading;
    } catch {
      traceDiffHighlight("highlight-source-error", { request, file: fileTraceId });
      // Patch-only colors below, retried with the source on a later viewport.
      for (const row of fileRows) retryableRowIds.push(row.id);
      continue;
    }
    if (input.signal?.aborted) break;
    const contexts = source ? getFullSourceContexts(source) : null;
    const fileTokens: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
    for (const side of ["old", "new"] as const) {
      if (input.signal?.aborted) break;
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
        knownLines: context?.comparisonLines.length,
      });
      if (!context) continue;
      // Rows the source cannot vouch for keep patch-only grammar below.
      const matchingRows: { row: NativeReviewDiffLineRow; lineIndex: number }[] = [];
      for (const row of fileRows) {
        if (displaySide(row) !== side) continue;
        const lineNumber = side === "old" ? row.oldLineNumber : row.newLineNumber;
        const lineIndex = typeof lineNumber === "number" ? lineNumber - 1 : -1;
        if (
          lineIndex >= 0 &&
          lineIndex < context.comparisonLines.length &&
          context.comparisonLines[lineIndex] === row.content
        ) {
          matchingRows.push({ row, lineIndex });
        }
      }
      if (matchingRows.length === 0) continue;
      const tokens = tokenize(context, context.contents, file.language);
      for (const { row, lineIndex } of matchingRows) {
        selectedRowIds.delete(row.id);
        fileTokens[row.id] = tokensByRowId[row.id] =
          tokens.highlightLine(lineIndex, input.scheme) ?? makePlainTokenFallback(row);
      }
    }
    emitChunk(fileTokens, []);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (selectedRowIds.size > 0 && !input.signal?.aborted) {
    highlightSegmentRows(selectedRowIds, tokensByRowId);
  }

  if (input.signal?.aborted) {
    traceDiffHighlight("highlight-aborted", { request });
    return {
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
    tokensByRowId,
    retryableRowIds,
    rowCount: selectedRows.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
