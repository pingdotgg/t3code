import type {
  EnvironmentId,
  OrchestrationV2GetThreadInsightsResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "../environment/scoped.ts";

export interface ThreadInsightsAnswer {
  readonly target: ScopedThreadRef;
  readonly data: OrchestrationV2GetThreadInsightsResult;
}

/** Only reachable answers contribute; a removed remote child must not leave stale spend behind. */
export function mergeThreadInsights(
  root: ScopedThreadRef,
  answers: ReadonlyMap<string, ThreadInsightsAnswer>,
) {
  const pending: (ScopedThreadRef & { title: string })[] = [];
  const rows = new Map<
    string,
    OrchestrationV2GetThreadInsightsResult["rows"][number] & { environmentId: EnvironmentId }
  >();
  const queue = [{ ...root, title: "This thread" }];
  const visited = new Set<string>();
  let truncated = false;
  let unavailable = 0;
  for (let index = 0; index < queue.length; index++) {
    const target = queue[index]!;
    const key = scopedThreadKey(target);
    if (visited.has(key)) continue;
    if (visited.size >= 200) {
      truncated = true;
      break;
    }
    visited.add(key);
    const answer = answers.get(key)?.data;
    if (answer === undefined) {
      pending.push(target);
      continue;
    }
    truncated ||= answer.truncated;
    unavailable += answer.unavailableThreadIds.length;
    for (const row of answer.rows) {
      const rowKey = scopedThreadKey({
        environmentId: target.environmentId,
        threadId: row.threadId,
      });
      if (rows.size >= 200 && !rows.has(rowKey)) {
        truncated = true;
        continue;
      }
      rows.set(rowKey, { ...row, environmentId: target.environmentId });
    }
    queue.push(...answer.remotes);
  }
  const values = [...rows.values()];
  const lists = values.flatMap((row) => (row.steps === null ? [] : [row.steps]));
  const sum = (
    field: "inputTokens" | "cachedInputTokens" | "cacheCreationTokens" | "outputTokens",
  ) => {
    const known = values.flatMap((row) =>
      row.usage[field] === undefined ? [] : [row.usage[field]!],
    );
    return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
  };
  const costs = values.flatMap((row) => (row.usage.costUsd === null ? [] : [row.usage.costUsd]));
  return {
    rows: values,
    pending,
    truncated,
    unavailable,
    partial:
      truncated ||
      unavailable > 0 ||
      pending.length > 0 ||
      values.some((row) => row.usage.status !== "complete" || row.usage.hasOtherUsage),
    tasks: {
      lists: lists.length,
      done: lists.flat().filter((step) => step.status === "completed").length,
      total: lists.flat().length,
    },
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
    outputTokens: sum("outputTokens"),
    costUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    unpricedTurns: values.reduce((sum, row) => sum + row.usage.unpricedTurns, 0),
  };
}
