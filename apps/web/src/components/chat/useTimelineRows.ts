import { useEffect, useState } from "react";
import {
  computeStableMessagesTimelineRows,
  handoffRunsSignature,
  type MessagesTimelineRowsInput,
  sameRowsInput,
  deriveMessagesTimelineRowsWithState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { type HandoffTimelineRun } from "./V2LifecycleRow";

const EMPTY_TIMELINE_RUNS: ReadonlyArray<HandoffTimelineRun> = [];

export function useStableHandoffRuns(
  runs: ReadonlyArray<HandoffTimelineRun>,
): ReadonlyArray<HandoffTimelineRun> {
  const [state, setState] = useState<{
    readonly source: ReadonlyArray<HandoffTimelineRun> | null;
    readonly signature: string;
    readonly value: ReadonlyArray<HandoffTimelineRun>;
  }>({ source: null, signature: "", value: EMPTY_TIMELINE_RUNS });
  if (state.source === runs) return state.value;
  const signature = handoffRunsSignature(runs);
  const value =
    signature === state.signature
      ? state.value
      : runs.map((run) => ({
          id: run.id,
          ordinal: run.ordinal,
          providerInstanceId: run.providerInstanceId,
          modelSelection: run.modelSelection,
        }));
  setState({ source: runs, signature, value });
  return value;
}

/**
 * Rows derived from the previous projection of the same list, so a streamed
 * text update patches its message rows instead of deriving every row again.
 */
export function useIncrementalTimelineRows(
  identity: string,
  input: MessagesTimelineRowsInput,
): MessagesTimelineRow[] {
  const [state, setState] = useState(() => ({
    identity,
    input,
    projection: deriveMessagesTimelineRowsWithState(input),
  }));
  if (state.identity === identity && sameRowsInput(state.input, input)) {
    return state.projection.rows;
  }
  const projection = deriveMessagesTimelineRowsWithState(
    input,
    state.identity === identity ? state.projection : null,
  );
  setState({ identity, input, projection });
  return projection.rows;
}

export function useStableRows(
  rows: MessagesTimelineRow[],
  identity: string,
): MessagesTimelineRow[] {
  const [state, setState] = useState<{
    readonly identity: string;
    readonly source: MessagesTimelineRow[] | null;
    readonly stable: StableMessagesTimelineRowsState;
  }>({ identity, source: null, stable: { byId: new Map(), result: [] } });
  if (state.identity === identity && state.source === rows) return state.stable.result;
  const stable = computeStableMessagesTimelineRows(
    rows,
    state.identity === identity ? state.stable : { byId: new Map(), result: [] },
  );
  setState({ identity, source: rows, stable });
  return stable.result;
}

const ROW_ARRIVAL_WINDOW_MS = 600;
const MAX_ANIMATED_ARRIVALS = 16;

/**
 * Rows that joined the list since the last update, with their position in the batch. Opening a
 * thread is not an arrival, and neither is a batch too large to read as individual rows.
 */
export function useTimelineRowArrivals(
  rows: MessagesTimelineRow[],
  identity: string,
): ReadonlyMap<string, number> {
  const [state, setState] = useState<{
    readonly identity: string;
    readonly rows: MessagesTimelineRow[];
    readonly known: ReadonlySet<string>;
    readonly arrivals: ReadonlyMap<string, number>;
  }>({
    identity,
    rows,
    known: new Set(rows.map((row) => row.id)),
    arrivals: new Map(),
  });
  let current = state;
  if (state.identity !== identity) {
    current = { identity, rows, known: new Set(rows.map((row) => row.id)), arrivals: new Map() };
    setState(current);
  } else if (state.rows !== rows) {
    const added = rows.filter((row) => !state.known.has(row.id));
    const arrivals = new Map(state.arrivals);
    const rowIds = new Set(rows.map((row) => row.id));
    const removedCount = state.rows.filter((row) => !rowIds.has(row.id)).length;
    // A live row settling into its final row swaps ids in place; fading that would read as a blink.
    const isReplacement = removedCount >= added.length;
    if (state.known.size > 0 && !isReplacement && added.length <= MAX_ANIMATED_ARRIVALS) {
      added.forEach((row, index) => arrivals.set(row.id, index));
    }
    current = {
      identity,
      rows,
      known: added.length === 0 ? state.known : rowIds,
      arrivals,
    };
    setState(current);
  }

  const hasArrivals = current.arrivals.size > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- arrivals expire on a timer so a row scrolled back into view later does not replay its entrance
  useEffect(() => {
    if (!hasArrivals) return;
    const timeout = window.setTimeout(
      () => setState((latest) => ({ ...latest, arrivals: new Map() })),
      ROW_ARRIVAL_WINDOW_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each new batch restarts the window so it stays visible for its full entrance
    current.arrivals,
    hasArrivals,
  ]);

  return current.arrivals;
}
