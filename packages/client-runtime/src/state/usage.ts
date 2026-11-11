import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ThreadId,
  UsageModelFilter,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

/**
 * The usage query for one thread, from the day it was created. Null for a server that would
 * ignore `threadId` and answer with every thread's usage.
 */
export function threadUsageSummaryInput(input: {
  readonly threadId: ThreadId;
  readonly createdAt: DateTime.Utc;
  readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "usageThreadFilter"> | undefined;
  readonly now?: DateTime.Utc;
}): UsageSummaryInput | null {
  if (input.capabilities?.usageThreadFilter !== true) return null;
  const { untilDay, timeZone } = makeWindow(
    1,
    input.now === undefined ? undefined : DateTime.toDateUtc(input.now),
  );
  const createdDay = makeWindow(1, DateTime.toDateUtc(input.createdAt)).untilDay;
  return {
    // A viewer whose clock trails the server's can see a thread created "tomorrow".
    sinceDay: createdDay < untilDay ? createdDay : untilDay,
    untilDay,
    timeZone,
    threadId: input.threadId,
  };
}

/**
 * Decides when to read a thread's usage again. A turn's last records reach the transcript as it
 * ends, and a read in flight at that moment may have scanned before them, so that read's answer
 * is followed by another.
 */
export function makeTurnEndRefresh(): (lastTurnEndMs: number, waiting: boolean) => boolean {
  // The latest turn end that the read in flight, or the answer in hand, began after.
  let readAfter: number | null = null;
  return (lastTurnEndMs, waiting) => {
    if (readAfter === null) {
      readAfter = lastTurnEndMs;
      return false;
    }
    if (waiting || readAfter === lastTurnEndMs) return false;
    readAfter = lastTurnEndMs;
    return true;
  };
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<EnvironmentId, Promise<unknown>>();

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (pending !== undefined) {
    return automatic ? undefined : ((await pending) as A);
  }
  const refreshAfter = limitsRefreshAfter.get(environmentId) ?? 0;
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < refreshAfter) return;
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      limitsRefreshes.delete(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshAfter.set(environmentId, Date.now() + 5 * 60_000);
    });
  limitsRefreshes.set(environmentId, current);
  return await current;
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({
        environmentId,
        input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
      });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
