import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import {
  threadShellHasActiveWork,
  turnItemUpdateCanEndBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { manualSettlementAbove } from "./SubRunSettlement.ts";

/** Finished sub-runs follow the remote parent's manual settlement via thread.sub-run.settle.
 * Relays may take a minute per hop or never answer; query outside the orchestrator so
 * its run-ending handler can start the next queued run without waiting. */

// Parent links are acyclic; this only bounds a corrupt or adversarial chain.
const MAX_HOPS = 16;

/**
 * The manual settle time of the thread, or of its nearest manually settled ancestor past ones
 * that only aged out. Null when none is, or when it cannot be told: no app reaches the
 * environment, or the environment or app predates reporting how a thread settled.
 */
export const manualSettledAt = Effect.fn("RemoteParentSettlement.manualSettledAt")(function* (
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Effect.fn.Return<DateTime.Utc | null, never, McpGatewayBroker> {
  const broker = yield* McpGatewayBroker;
  let environment = environmentId;
  let current = threadId;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if ((yield* broker.access).grants[environment]?.includes("read") !== true) return null;
    const found = yield* broker.call("getThread", [environment, current]).pipe(Effect.option);
    if (found._tag === "None" || found.value.settledAt == null) return null;
    const thread = found.value;
    if (thread.settlementSource === "manual") return thread.settledAt ?? null;
    if (thread.settlementSource !== "inactivity" || thread.parentThreadId == null) return null;
    environment = thread.parentEnvironmentId ?? environment;
    current = thread.parentThreadId;
  }
  return null;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const eventSink = yield* EventSinkV2;
    const broker = yield* McpGatewayBroker;
    // One lookup per sub-run at a time; it reads the latest state when it answers.
    const lookups = yield* FiberMap.make<ThreadId>();

    const settle = (
      threadId: ThreadId,
      completion: string,
      environmentId: EnvironmentId,
      parent: ThreadId,
    ) =>
      manualSettledAt(environmentId, parent).pipe(
        Effect.flatMap((parentSettledAt) =>
          parentSettledAt === null
            ? Effect.void
            : engine.dispatch({
                type: "thread.sub-run.settle",
                commandId: CommandId.make(`server:sub-run-settle:${threadId}:${completion}`),
                threadId,
                parentSettledAt,
              }),
        ),
        Effect.provideService(McpGatewayBroker, broker),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not follow a parent on another environment", {
            threadId,
            cause,
          }),
        ),
      );

    const onEnding = Effect.fn("RemoteParentSettlement.onEnding")(
      function* (threadId: ThreadId, completion: string) {
        const thread = yield* projections.getThread(threadId);
        if (thread.settledOverride !== null) return;
        const above = yield* manualSettlementAbove(projections, thread);
        if (above === null || !("remote" in above)) return;
        // Ask the other machine only once nothing here keeps the sub-run active.
        const shell = yield* projections.getThreadShell(threadId);
        if (
          shell === null ||
          threadShellHasActiveWork(shell) ||
          (shell.pendingBackgroundTasks?.length ?? 0) > 0
        ) {
          return;
        }
        yield* FiberMap.run(
          lookups,
          threadId,
          settle(threadId, completion, above.remote.environmentId, above.remote.threadId),
          { onlyIfMissing: true },
        );
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check a sub-run's remote parent", { threadId, cause }),
          ),
        ),
    );

    // The same endings the orchestrator settles local sub-runs on: a finished run, or background
    // work its last turn left open ending on its own.
    const completionOf = (stored: OrchestrationV2StoredEvent): string | null => {
      const { event } = stored;
      switch (event.type) {
        case "run.updated":
          return !String(stored.commandId).startsWith("command:runtime-reconcile:") &&
            (event.payload.status === "completed" ||
              event.payload.status === "interrupted" ||
              event.payload.status === "cancelled")
            ? String(event.payload.id)
            : null;
        case "turn-item.updated":
          return turnItemUpdateCanEndBackgroundWork(event.payload)
            ? `event:${stored.sequence}`
            : null;
        case "provider-thread.updated":
          return `event:${stored.sequence}`;
        default:
          return null;
      }
    };

    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* Stream.mergeAll(
      (["run.updated", "turn-item.updated", "provider-thread.updated"] as const).map((eventType) =>
        eventSink.stream({ afterSequence, eventType }),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach((stored) => {
        const completion = completionOf(stored);
        return completion === null ? Effect.void : onEnding(stored.event.threadId, completion);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Remote parent settlement event stream failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
