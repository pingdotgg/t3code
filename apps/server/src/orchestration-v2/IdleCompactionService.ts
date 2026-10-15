import {
  CommandId,
  MessageId,
  resolveProjectProviderInstanceEnabled,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  idleCompactionCandidate,
  idleCompactionWindow,
  MAX_PROMPT_CACHE_TTL_MS,
} from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

class IdleCompactionServiceV2 extends Context.Service<
  IdleCompactionServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IdleCompactionService/IdleCompactionServiceV2") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const config = yield* ServerConfig.ServerConfig;

  const sweep = Effect.fn("IdleCompactionServiceV2.sweep")(function* (threadId?: ThreadId) {
    if (!(yield* settings.getSettings).compactIdleThreads) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    // Runs that completed before the longest TTL can never be due again.
    const lookbackMs = Math.max(MAX_PROMPT_CACHE_TTL_MS, (config.idleCompactionDelayMs ?? 0) * 2);
    const candidates = yield* projections.getIdleCompactionCandidates({
      completedAfter: DateTime.makeUnsafe(nowMs - lookbackMs),
      ...(threadId === undefined ? {} : { threadId }),
    });
    const compactThread = Effect.fn("IdleCompactionServiceV2.compactThread")(
      function* (candidate: (typeof candidates)[number]) {
        const window = idleCompactionWindow(
          candidate.completedAt,
          candidate.driver,
          config.idleCompactionDelayMs,
        );
        if (nowMs < window.startMs || nowMs >= window.endMs) return;
        // Only due threads load their history. The minute scan stays independent
        // of transcript size, like the settlement worker's candidate query.
        const projection = yield* projections.getThreadProjection(candidate.threadId);
        const currentSettings = yield* settings.getSettings;
        const current = idleCompactionCandidate(
          projection,
          currentSettings.compactIdleThreads &&
            resolveProjectProviderInstanceEnabled(
              currentSettings,
              projection.thread.projectId,
              projection.thread.providerInstanceId,
            ),
          nowMs,
        );
        if (current === null || current.runId !== candidate.runId) return;
        const instance = yield* instances.getInstance(projection.thread.providerInstanceId);
        // Enablement is the project-resolved value above; a project can enable
        // an instance that is disabled machine-wide.
        if (instance === undefined || instance.driverKind !== current.driver) return;
        // Earlier candidates in this sweep can push this one past its cache TTL.
        if (DateTime.toEpochMillis(yield* DateTime.now) >= window.endMs) return;
        // One idempotent command per completed run survives concurrent scans and
        // restarts; dispatch rechecks eligibility under the thread's lock.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:idle-compact:${current.threadId}:${current.runId}`),
          messageId: MessageId.make(`idle-compact:${current.threadId}:${current.runId}`),
          threadId: current.threadId,
          text: "/compact",
          attachments: [],
          createdBy: "system",
          creationSource: "server",
          idleCompactionOfRunId: current.runId,
          dispatchMode: { type: "start_immediately" },
        });
      },
      (effect, candidate) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("idle compaction skipped", {
                  threadId: candidate.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
    );
    yield* Effect.forEach(candidates, compactThread, { discard: true });
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    sweep(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("idle compaction sweep failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const start: IdleCompactionServiceV2["Service"]["start"] = Effect.fn(
    "IdleCompactionServiceV2.start",
  )(function* () {
    const changes = yield* settings.subscribeChanges;
    let enabled = (yield* settings.getSettings.pipe(Effect.orDie)).compactIdleThreads;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(changes, (next) => {
        if (next.compactIdleThreads === enabled) return Effect.void;
        enabled = next.compactIdleThreads;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? worker.enqueue(event.threadId)
          : Effect.void,
      ),
    );
  });
  return { start, drain: worker.drain } satisfies IdleCompactionServiceV2["Service"];
});
