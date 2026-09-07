import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
} as const;

function completedThreadShell(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly completedAt: string;
}): OrchestrationThreadShell {
  return {
    id: input.threadId,
    projectId: ProjectId.make("project-provider-session-reaper-activity"),
    title: "Provider session reaper activity",
    modelSelection: defaultModelSelection,
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: input.completedAt,
    updatedAt: input.completedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    latestTurn: {
      turnId: input.turnId,
      state: "completed",
      requestedAt: input.completedAt,
      startedAt: input.completedAt,
      completedAt: input.completedAt,
      assistantMessageId: null,
    },
    session: {
      threadId: input.threadId,
      status: "ready",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: input.completedAt,
    },
    backgroundLiveness: null,
  };
}

describe("ProviderSessionReaper turn activity", () => {
  it.effect("refreshes lastSeenAt when a provider turn completes", () =>
    Effect.gen(function* () {
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const threadId = ThreadId.make("thread-reaper-turn-activity");
      const turnId = TurnId.make("turn-reaper-turn-activity");
      const initialLastSeenAt = "2026-01-01T00:00:00.000Z";

      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const layer = makeProviderSessionReaperLive({
        inactivityThresholdMs: Number.MAX_SAFE_INTEGER,
        sweepIntervalMs: 60_000,
      }).pipe(
        Layer.provideMerge(providerSessionDirectoryLayer),
        Layer.provideMerge(runtimeRepositoryLayer),
        Layer.provideMerge(
          Layer.mock(ProviderService)({
            stopSession: () => Effect.void,
            streamEvents: Stream.fromQueue(runtimeEvents),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const reaper = yield* ProviderSessionReaper;

        yield* repository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: initialLastSeenAt,
          resumeCursor: { opaque: "resume-turn-activity" },
          runtimePayload: { marker: "preserve-me" },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* reaper.start();
            yield* Queue.offer(runtimeEvents, {
              type: "turn.completed",
              eventId: EventId.make("evt-reaper-turn-completed"),
              provider: ProviderDriverKind.make("claudeAgent"),
              threadId,
              turnId,
              createdAt: "2026-09-08T00:00:00.000Z",
              payload: { state: "completed" },
            });
            yield* drainFibers;

            const binding = yield* repository.getByThreadId({ threadId });
            expect(Option.isSome(binding)).toBe(true);
            if (Option.isNone(binding)) return;

            expect(Date.parse(binding.value.lastSeenAt)).toBeGreaterThan(
              Date.parse(initialLastSeenAt),
            );
            expect(binding.value.runtimePayload).toEqual({ marker: "preserve-me" });
            expect(binding.value.resumeCursor).toEqual({ opaque: "resume-turn-activity" });
            expect(binding.value.status).toBe("running");
          }),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not reap after projection records a fresh turn completion before the touch lands", () =>
    Effect.gen(function* () {
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const threadId = ThreadId.make("thread-reaper-completion-race");
      const turnId = TurnId.make("turn-reaper-completion-race");
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      const threadShell = completedThreadShell({ threadId, turnId, completedAt });
      let stopCount = 0;

      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const layer = makeProviderSessionReaperLive({
        inactivityThresholdMs: 1_000,
        sweepIntervalMs: 60_000,
      }).pipe(
        Layer.provideMerge(providerSessionDirectoryLayer),
        Layer.provideMerge(runtimeRepositoryLayer),
        Layer.provideMerge(
          Layer.mock(ProviderService)({
            stopSession: () => Effect.sync(() => void (stopCount += 1)),
            streamEvents: Stream.fromQueue(runtimeEvents),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () => Effect.succeed(Option.some(threadShell)),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const reaper = yield* ProviderSessionReaper;

        yield* repository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          resumeCursor: { opaque: "resume-completion-race" },
          runtimePayload: null,
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* reaper.start();
            yield* drainFibers;
            expect(stopCount).toBe(0);
          }),
        );
      }).pipe(Effect.provide(layer));
    }),
  );
});
