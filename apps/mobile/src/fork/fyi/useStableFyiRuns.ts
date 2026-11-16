import { useState } from "react";
import type { OrchestrationV2Run, RunId } from "@t3tools/contracts";
import {
  fyiCarrierRuns,
  fyiRunIds,
  type FyiCarrierRun,
} from "@t3tools/client-runtime/fork/fyi-marker";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

const EMPTY_FYI_RUNS: ReadonlyMap<RunId, FyiCarrierRun> = new Map();

/** Stable while none of the runs FYI messages name changes, so other runs' updates spare the feed. */
export function useStableFyiRuns(
  feed: ReadonlyArray<ThreadFeedEntry>,
  runs: ReadonlyArray<FyiCarrierRun & Pick<OrchestrationV2Run, "id">>,
): ReadonlyMap<RunId, FyiCarrierRun> {
  const [stableFyiRuns, setStableFyiRuns] = useState({ key: "", value: EMPTY_FYI_RUNS });
  const nextFyiRuns = fyiCarrierRuns(
    fyiRunIds(
      feed.map((entry) =>
        entry.type === "message" ? entry.message.projectedItem?.item : undefined,
      ),
    ),
    runs,
  );
  if (nextFyiRuns.key !== stableFyiRuns.key) {
    setStableFyiRuns({ key: nextFyiRuns.key, value: nextFyiRuns.runs });
  }
  return nextFyiRuns.key === stableFyiRuns.key ? stableFyiRuns.value : nextFyiRuns.runs;
}
