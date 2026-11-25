/** Save the row at the current offset; a virtualizer's cached visible range can lag a fling. */
export function resolveWorkGroupScrollAnchor(state: {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly scroll: number;
  readonly positionAtIndex: (index: number) => number | undefined;
}) {
  if (state.data.length === 0 || !Number.isFinite(state.scroll)) return undefined;
  const scrollOffset = Math.max(0, state.scroll);
  let low = 0;
  let high = state.data.length - 1;
  let index = 0;
  let rowTop = state.positionAtIndex(0);
  if (rowTop === undefined || !Number.isFinite(rowTop)) return undefined;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const top = state.positionAtIndex(middle);
    if (top === undefined || !Number.isFinite(top)) return undefined;
    if (top <= scrollOffset) {
      index = middle;
      rowTop = top;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return {
    rowId: state.data[index]!.id,
    offsetWithinRow: Math.max(0, scrollOffset - rowTop),
    scrollOffset,
  };
}

/**
 * The run whose rows reach into the view, scanning back from the end through `runId`'s rows.
 * Folding it would pull away the rows a reader who stopped following is reading.
 */
export function resolveRunInView<Row, RunId>(
  rows: ReadonlyArray<Row>,
  state: {
    readonly scroll: number;
    readonly scrollLength: number;
    readonly positionAtIndex: (index: number) => number | undefined;
  },
  runId: RunId | undefined,
  rowRunId: (row: Row) => RunId | null | undefined,
): RunId | null {
  if (runId === undefined) return null;
  let firstIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const rowRun = rowRunId(rows[index]!);
    if (rowRun === null || rowRun === undefined) continue;
    if (rowRun !== runId) break;
    firstIndex = index;
  }
  const top = firstIndex < 0 ? undefined : state.positionAtIndex(firstIndex);
  return top !== undefined && top < state.scroll + state.scrollLength ? runId : null;
}

/**
 * Open runs after the latest run changes: an interrupted run, or one the reader is in when it
 * ends, opens its fold; a newer run closes the previous run's unless the reader is still in it.
 * `foldKeys` lists the shown folds; work after a steer folds under `${runId}:steer:${steerId}`,
 * so the reader's run opens those segments too.
 */
export function nextExpandedRuns<RunId extends string>(
  expanded: ReadonlySet<RunId>,
  previous: { readonly runId: RunId; readonly status: string | undefined } | null,
  latest: { readonly runId: RunId; readonly status: string | undefined } | null,
  readerRunId: RunId | null,
  foldKeys: () => Iterable<RunId> = () => [],
): ReadonlySet<RunId> {
  if (!previous || !latest) return expanded;
  if (latest.runId === previous.runId) {
    if (previous.status !== "running") return expanded;
    const opening =
      readerRunId === latest.runId
        ? [
            latest.runId,
            ...[...foldKeys()].filter((key) => key.startsWith(`${latest.runId}:steer:`)),
          ]
        : latest.status === "interrupted"
          ? [latest.runId]
          : [];
    const added = opening.filter((key) => !expanded.has(key));
    return added.length > 0 ? new Set([...expanded, ...added]) : expanded;
  }
  if (readerRunId === previous.runId || !expanded.has(previous.runId)) return expanded;
  const next = new Set(expanded);
  next.delete(previous.runId);
  return next;
}
