// @effect-diagnostics globalDate:off -- The active thread window ends on the viewer's current calendar day.
import { useAtomValue } from "@effect/atom-react";
import {
  UsageDay,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ThreadId,
  type UsageThreadBreakdown,
  type UsageThreadBreakdownInput,
  type UsageThreadRow,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

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
  untilDay?: UsageDay,
): UsageThreadBreakdownInput {
  const { timeZone, format } = dayFormatter();
  const created = new Date(createdAt);
  const validCreatedAt = Number.isNaN(created.getTime()) || created > now ? now : created;
  return {
    sinceDay: UsageDay.make(format.format(validCreatedAt)),
    untilDay: untilDay ?? UsageDay.make(format.format(now)),
    timeZone,
    threadId,
  };
}

function currentThreadCostDay(now = new Date()): UsageDay {
  return UsageDay.make(dayFormatter().format.format(now));
}

export function millisecondsUntilNextThreadCostDay(now = new Date()): number {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  return Math.max(1, nextDay.getTime() - now.getTime() + 1000);
}

export function supportsThreadCostBreakdown(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "usageThreadFilter"> | null,
): boolean | null {
  return capabilities === null ? null : capabilities.usageThreadFilter === true;
}

interface ThreadCostState {
  readonly breakdown: UsageThreadBreakdown | null;
  readonly isPending: boolean;
  readonly supported: boolean | null;
}

export function resolveThreadCostState(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "usageThreadFilter"> | null,
  readBreakdown: () => Pick<ThreadCostState, "breakdown" | "isPending">,
): ThreadCostState {
  const supported = supportsThreadCostBreakdown(capabilities);
  if (supported !== true) {
    return { breakdown: null, isPending: supported === null, supported };
  }
  return { ...readBreakdown(), supported: true };
}

export function summarizeThreadCost(
  rows: readonly UsageThreadRow[],
  threadId: ThreadId,
): ThreadCostSnapshot {
  const matching = rows.filter((row) => row.threadId === threadId);
  let costUsd = 0;
  let cacheWriteUsd = 0;
  let pricedCacheWriteUsd = 0;
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
      pricedCacheWriteUsd += day.cacheWriteUsd;
      cacheReadUsd += day.cacheReadUsd;
      freshUsd += day.freshUsd;
    }
  }

  const pricedComponents = pricedCacheWriteUsd + cacheReadUsd + freshUsd;
  const providerReportedUsd = Math.max(
    0,
    costUsd - (cacheWriteComplete ? pricedComponents : cacheReadUsd + freshUsd),
  );
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
  const [currentDay, setCurrentDay] = useState(() => currentThreadCostDay());
  useEffect(() => {
    let timeout: number | undefined;
    const schedule = () => {
      timeout = window.setTimeout(() => {
        setCurrentDay(currentThreadCostDay());
        schedule();
      }, millisecondsUntilNextThreadCostDay());
    };
    schedule();
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, []);

  const requestInput = useMemo(
    () => makeThreadCostInput(input.threadId, input.createdAt, new Date(), currentDay),
    [currentDay, input.createdAt, input.threadId],
  );
  const queries = useMemo(() => {
    const breakdownQuery = serverEnvironment.usageThreadBreakdown({
      environmentId: input.environmentId,
      input: requestInput,
    });
    const stateAtom = Atom.make((get): ThreadCostState =>
      resolveThreadCostState(
        get(serverEnvironment.configValueAtom(input.environmentId))?.environment.capabilities ??
          null,
        () => {
          const breakdownResult = get(breakdownQuery);
          return {
            breakdown: Option.getOrNull(AsyncResult.value(breakdownResult)),
            isPending: breakdownResult.waiting,
          };
        },
      ),
    );
    return { breakdownQuery, stateAtom };
  }, [input.environmentId, requestInput]);
  const state = useAtomValue(queries.stateAtom);
  const supported = useRef<boolean | null>(state.supported);
  useEffect(() => {
    supported.current = state.supported;
  }, [state.supported]);

  const previousRefreshKey = useRef(input.refreshKey);
  useEffect(() => {
    if (input.refreshKey === null || previousRefreshKey.current === input.refreshKey) return;
    previousRefreshKey.current = input.refreshKey;
    const timeout = window.setTimeout(() => {
      if (supported.current === true) {
        appAtomRegistry.refresh(queries.breakdownQuery);
      }
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [input.refreshKey, queries.breakdownQuery]);

  return {
    cost:
      state.breakdown === null ? null : summarizeThreadCost(state.breakdown.rows, input.threadId),
    isPending: state.isPending,
  };
}
