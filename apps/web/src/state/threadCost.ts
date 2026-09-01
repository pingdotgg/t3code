// @effect-diagnostics globalDate:off -- The active thread window ends on the viewer's current calendar day.
import { useAtomValue } from "@effect/atom-react";
import {
  UsageDay,
  type EnvironmentId,
  type ThreadId,
  type UsageThreadBreakdownInput,
  type UsageThreadRow,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";

export interface ThreadCostSnapshot {
  readonly costUsd: number;
  readonly cacheWriteUsd: number | null;
  readonly cacheReadUsd: number;
  readonly freshUsd: number;
  readonly providerReportedUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

function dayFormatter(): { readonly timeZone: string; readonly format: Intl.DateTimeFormat } {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    return {
      timeZone,
      format: new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    };
  } catch {
    timeZone = "UTC";
    return {
      timeZone,
      format: new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    };
  }
}

export function makeThreadCostInput(
  threadId: ThreadId,
  createdAt: string,
  now = new Date(),
): UsageThreadBreakdownInput {
  const { timeZone, format } = dayFormatter();
  const created = new Date(createdAt);
  const validCreatedAt = Number.isNaN(created.getTime()) || created > now ? now : created;
  return {
    sinceDay: UsageDay.make(format.format(validCreatedAt)),
    untilDay: UsageDay.make(format.format(now)),
    timeZone,
    threadId,
  };
}

export function summarizeThreadCost(
  rows: readonly UsageThreadRow[],
  threadId: ThreadId,
): ThreadCostSnapshot {
  const matching = rows.filter((row) => row.threadId === threadId);
  let costUsd = 0;
  let cacheWriteUsd = 0;
  let cacheWriteComplete = true;
  let cacheReadUsd = 0;
  let freshUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;

  for (const row of matching) {
    costUsd += row.costUsd;
    cacheWriteUsd += row.cacheWriteUsd ?? 0;
    if (row.totals.cacheCreationTokens > 0 && row.cacheWriteUsd === null) {
      cacheWriteComplete = false;
    }
    uncachedInputTokens += row.totals.uncachedInputTokens;
    cachedInputTokens += row.totals.cachedInputTokens;
    cacheCreationTokens += row.totals.cacheCreationTokens;
    outputTokens += row.totals.outputTokens;
    for (const day of row.daily) {
      cacheReadUsd += day.cacheReadUsd;
      freshUsd += day.freshUsd;
    }
  }

  const pricedComponents = cacheWriteUsd + cacheReadUsd + freshUsd;
  const providerReportedUsd = Math.max(0, costUsd - pricedComponents);
  return {
    costUsd,
    cacheWriteUsd: cacheWriteComplete ? cacheWriteUsd : null,
    cacheReadUsd,
    freshUsd,
    providerReportedUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
  };
}

export function useThreadCost(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly refreshKey: string | null;
}): { readonly cost: ThreadCostSnapshot | null; readonly isPending: boolean } {
  const requestInput = useMemo(
    () => makeThreadCostInput(input.threadId, input.createdAt),
    [input.createdAt, input.threadId],
  );
  const query = useMemo(
    () =>
      serverEnvironment.usageThreadBreakdown({
        environmentId: input.environmentId,
        input: requestInput,
      }),
    [input.environmentId, requestInput],
  );
  const result = useAtomValue(query);
  const previousRefreshKey = useRef(input.refreshKey);

  useEffect(() => {
    if (input.refreshKey === null || previousRefreshKey.current === input.refreshKey) return;
    previousRefreshKey.current = input.refreshKey;
    const timeout = window.setTimeout(() => appAtomRegistry.refresh(query), 750);
    return () => window.clearTimeout(timeout);
  }, [input.refreshKey, query]);

  const breakdown = Option.getOrNull(AsyncResult.value(result));
  return {
    cost: breakdown === null ? null : summarizeThreadCost(breakdown.rows, input.threadId),
    isPending: result.waiting,
  };
}
