import type {
  NativeReviewDiffRow,
  NativeReviewDiffWordDiffRange,
} from "../diffs/nativeReviewDiffSurface";
import { computeWordAltDiffRanges } from "./reviewWordDiffs";

const MAX_WORD_DIFF_RANGE_COUNT = 4;
const MAX_WORD_DIFF_COVERAGE = 0.45;
const VISIBLE_OVERSCAN_ROWS = 160;
const VISIBLE_MAX_PAIRS = 360;
const MAX_PAIRS_PER_BATCH = 32;
const MAX_BATCH_MILLISECONDS = 4;
const SCAN_BUDGET_CHECK_INTERVAL = 256;

interface WordDiffWorkBudget {
  startedAt: number;
  operations: number;
}

interface WordDiffPair {
  readonly deletion: NativeReviewDiffRow;
  readonly addition: NativeReviewDiffRow;
}

interface WordDiffPairRanges {
  readonly deletion: ReadonlyArray<NativeReviewDiffWordDiffRange>;
  readonly addition: ReadonlyArray<NativeReviewDiffWordDiffRange>;
}

const pairsByRows = new WeakMap<
  ReadonlyArray<NativeReviewDiffRow>,
  {
    readonly collapsedFileIds: ReadonlySet<string>;
    readonly pairs: ReadonlyArray<WordDiffPair | undefined>;
  }
>();
const rangesByDeletion = new WeakMap<
  NativeReviewDiffRow,
  { readonly addition: NativeReviewDiffRow; readonly ranges: WordDiffPairRanges }
>();

function trimWordDiffRanges(
  content: string,
  ranges: ReadonlyArray<NativeReviewDiffWordDiffRange>,
): ReadonlyArray<NativeReviewDiffWordDiffRange> {
  return ranges.flatMap((range) => {
    let start = Math.max(0, range.start);
    let end = Math.min(content.length, range.end);
    while (start < end && /\s/.test(content[start] ?? "")) start += 1;
    while (end > start && /\s/.test(content[end - 1] ?? "")) end -= 1;
    return end > start ? [{ start, end }] : [];
  });
}

function shouldUseWordDiffRanges(
  content: string,
  ranges: ReadonlyArray<NativeReviewDiffWordDiffRange>,
): boolean {
  if (ranges.length === 0 || ranges.length > MAX_WORD_DIFF_RANGE_COUNT) return false;
  const meaningfulLength = content.replace(/\s/g, "").length;
  if (meaningfulLength === 0) return false;
  const highlightedLength = ranges.reduce(
    (total, range) => total + content.slice(range.start, range.end).replace(/\s/g, "").length,
    0,
  );
  return highlightedLength / meaningfulLength <= MAX_WORD_DIFF_COVERAGE;
}

function shouldYieldScan(budget: WordDiffWorkBudget): boolean {
  budget.operations += 1;
  if (budget.operations < SCAN_BUDGET_CHECK_INTERVAL) return false;
  budget.operations = 0;
  return performance.now() - budget.startedAt >= MAX_BATCH_MILLISECONDS;
}

function sameCollapsedFiles(
  cached: ReadonlySet<string>,
  next: ReadonlySet<string> | undefined,
): boolean {
  if (cached.size !== (next?.size ?? 0)) return false;
  for (const id of cached) {
    if (!next?.has(id)) return false;
  }
  return true;
}

async function pauseWordDiffWork(budget: WordDiffWorkBudget): Promise<void> {
  await yieldWordDiffWork();
  budget.startedAt = performance.now();
  budget.operations = 0;
}

/** Index source pairs once. Comments do not change deletion/addition correspondence. */
async function getWordDiffPairs(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  budget: WordDiffWorkBudget,
  signal: AbortSignal | undefined,
  collapsedFileIds: ReadonlySet<string> | undefined,
): Promise<ReadonlyArray<WordDiffPair | undefined> | null> {
  const cached = pairsByRows.get(rows);
  if (cached && sameCollapsedFiles(cached.collapsedFileIds, collapsedFileIds)) return cached.pairs;
  const pairs: Array<WordDiffPair | undefined> = [];
  pairs.length = rows.length;
  let index = 0;
  while (index < rows.length) {
    if (shouldYieldScan(budget)) {
      await pauseWordDiffWork(budget);
      if (signal?.aborted) return null;
    }
    if (
      rows[index]!.kind !== "line" ||
      rows[index]!.change !== "delete" ||
      collapsedFileIds?.has(rows[index]!.fileId ?? "")
    ) {
      index += 1;
      continue;
    }
    const deletedIndexes: number[] = [];
    const addedIndexes: number[] = [];
    const fileId = rows[index]!.fileId;
    while (index < rows.length) {
      if (shouldYieldScan(budget)) {
        await pauseWordDiffWork(budget);
        if (signal?.aborted) return null;
      }
      const row = rows[index]!;
      if (row.kind === "comment") {
        index += 1;
        continue;
      }
      if (row.kind !== "line" || row.change !== "delete" || row.fileId !== fileId) break;
      deletedIndexes.push(index);
      index += 1;
    }
    while (index < rows.length) {
      if (shouldYieldScan(budget)) {
        await pauseWordDiffWork(budget);
        if (signal?.aborted) return null;
      }
      const row = rows[index]!;
      if (row.kind === "comment") {
        index += 1;
        continue;
      }
      if (row.kind !== "line" || row.change !== "add" || row.fileId !== fileId) break;
      addedIndexes.push(index);
      index += 1;
    }
    const pairedCount = Math.min(deletedIndexes.length, addedIndexes.length);
    for (let pairIndex = 0; pairIndex < pairedCount; pairIndex += 1) {
      if (shouldYieldScan(budget)) {
        await pauseWordDiffWork(budget);
        if (signal?.aborted) return null;
      }
      const deletionIndex = deletedIndexes[pairIndex]!;
      const additionIndex = addedIndexes[pairIndex]!;
      const pair = { deletion: rows[deletionIndex]!, addition: rows[additionIndex]! };
      pairs[deletionIndex] = pair;
      pairs[additionIndex] = pair;
    }
  }
  pairsByRows.set(rows, { pairs, collapsedFileIds: new Set(collapsedFileIds) });
  return pairs;
}

function getWordDiffPairRanges(pair: WordDiffPair): WordDiffPairRanges {
  const cached = rangesByDeletion.get(pair.deletion);
  if (cached?.addition === pair.addition) return cached.ranges;
  const deletionLine = pair.deletion.content ?? "";
  const additionLine = pair.addition.content ?? "";
  const ranges =
    deletionLine && additionLine
      ? computeWordAltDiffRanges({ deletionLine, additionLine })
      : { deletion: [], addition: [] };
  const deletion = trimWordDiffRanges(deletionLine, ranges.deletion);
  const addition = trimWordDiffRanges(additionLine, ranges.addition);
  const result = {
    deletion: shouldUseWordDiffRanges(deletionLine, deletion) ? deletion : [],
    addition: shouldUseWordDiffRanges(additionLine, addition) ? addition : [],
  };
  rangesByDeletion.set(pair.deletion, { addition: pair.addition, ranges: result });
  return result;
}

function yieldWordDiffWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Prepare visible pairs without waiting for syntax highlighting or changing source rows. */
export async function computeVisibleNativeReviewWordDiffRanges(input: {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
  readonly collapsedFileIds?: ReadonlySet<string>;
  readonly alreadyHighlightedRowIds?: ReadonlySet<string>;
  readonly overscanRows?: number;
  readonly maxPairs?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly rangesByRowId: Record<string, ReadonlyArray<NativeReviewDiffWordDiffRange>>;
  readonly pairCount: number;
}> {
  await yieldWordDiffWork();
  if (input.signal?.aborted) return { rangesByRowId: {}, pairCount: 0 };
  const budget = { startedAt: performance.now(), operations: 0 };
  const pairs = await getWordDiffPairs(input.rows, budget, input.signal, input.collapsedFileIds);
  if (pairs === null) return { rangesByRowId: {}, pairCount: 0 };
  const overscanRows = input.overscanRows ?? VISIBLE_OVERSCAN_ROWS;
  const start = Math.max(0, Math.floor(input.firstRowIndex - overscanRows));
  const end = Math.min(input.rows.length - 1, Math.ceil(input.lastRowIndex + overscanRows));
  const selectedPairs = new Set<WordDiffPair>();
  const rangesByRowId: Record<string, ReadonlyArray<NativeReviewDiffWordDiffRange>> = {};
  let batchCount = 0;
  for (
    let index = start;
    index <= end && selectedPairs.size < (input.maxPairs ?? VISIBLE_MAX_PAIRS);
    index += 1
  ) {
    if (shouldYieldScan(budget)) {
      await pauseWordDiffWork(budget);
      if (input.signal?.aborted) return { rangesByRowId: {}, pairCount: 0 };
      batchCount = 0;
    }
    const pair = pairs[index];
    if (
      !pair ||
      selectedPairs.has(pair) ||
      input.collapsedFileIds?.has(pair.deletion.fileId ?? "") ||
      (input.alreadyHighlightedRowIds?.has(pair.deletion.id) &&
        input.alreadyHighlightedRowIds.has(pair.addition.id))
    ) {
      continue;
    }
    if (
      batchCount >= MAX_PAIRS_PER_BATCH ||
      performance.now() - budget.startedAt >= MAX_BATCH_MILLISECONDS
    ) {
      await pauseWordDiffWork(budget);
      if (input.signal?.aborted) return { rangesByRowId: {}, pairCount: 0 };
      batchCount = 0;
    }
    const ranges = getWordDiffPairRanges(pair);
    rangesByRowId[pair.deletion.id] = ranges.deletion;
    rangesByRowId[pair.addition.id] = ranges.addition;
    selectedPairs.add(pair);
    batchCount += 1;
  }
  return input.signal?.aborted
    ? { rangesByRowId: {}, pairCount: 0 }
    : { rangesByRowId, pairCount: selectedPairs.size };
}
