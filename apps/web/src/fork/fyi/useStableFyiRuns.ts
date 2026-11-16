import { useState } from "react";
import type { RunId } from "@t3tools/contracts";
import {
  fyiCarrierRuns,
  fyiRunIds,
  type FyiCarrierRun,
} from "@t3tools/client-runtime/fork/fyi-marker";

import type { MessagesTimelineRow } from "../../components/chat/MessagesTimeline.logic";
import type { HandoffTimelineRun } from "../../components/chat/V2LifecycleRow";

const EMPTY_FYI_RUNS: ReadonlyMap<RunId, FyiCarrierRun> = new Map();
const NO_FYI_RUN_IDS: ReadonlySet<RunId> = new Set();

/**
 * The runs FYI rows name, kept while none of them changes so other runs' updates spare the rows.
 * Runs change on every stream event, so the rows are scanned only when they change.
 */
export function useStableFyiRuns(
  rows: ReadonlyArray<MessagesTimelineRow>,
  runs: ReadonlyArray<FyiCarrierRun & Pick<HandoffTimelineRun, "id">>,
): ReadonlyMap<RunId, FyiCarrierRun> {
  const [state, setState] = useState<{
    readonly rows: ReadonlyArray<MessagesTimelineRow> | null;
    readonly runIds: ReadonlySet<RunId>;
    readonly key: string;
    readonly value: ReadonlyMap<RunId, FyiCarrierRun>;
  }>({ rows: null, runIds: NO_FYI_RUN_IDS, key: "", value: EMPTY_FYI_RUNS });
  const runIds =
    state.rows === rows
      ? state.runIds
      : fyiRunIds(
          rows.map((row) => (row.kind === "message" ? row.projectedItem?.item : undefined)),
        );
  const next = fyiCarrierRuns(runIds, runs);
  if (state.rows === rows && next.key === state.key) return state.value;
  const value = next.key === state.key ? state.value : next.runs;
  setState({ rows, runIds, key: next.key, value });
  return value;
}
