import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { UsageLimitAutoResumeReactor } from "../Services/UsageLimitAutoResumeReactor.ts";
import { UsageLimitAutoResumeReactorLive } from "./UsageLimitAutoResumeReactor.ts";

const THREAD_ID = ThreadId.make("thread-usage-limit");
const WAIT_ID = CommandId.make("wait-usage-limit");
const BLOCKED_TURN_ID = TurnId.make("turn-blocked");
const EPOCH = "1970-01-01T00:00:00.000Z";
const RESUME_AT = "1970-01-01T00:01:00.000Z";

function makeShellSnapshot(): OrchestrationShellSnapshot {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const thread = {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Usage limited thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: BLOCKED_TURN_ID,
      state: "error",
      requestedAt: EPOCH,
      startedAt: EPOCH,
      completedAt: EPOCH,
      assistantMessageId: null,
    },
    createdAt: EPOCH,
    updatedAt: EPOCH,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    usageLimitWait: {
      waitId: WAIT_ID,
      blockedTurnId: BLOCKED_TURN_ID,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection,
      resumeAt: RESUME_AT,
      isEstimated: false,
      createdAt: EPOCH,
    },
    session: {
      threadId: THREAD_ID,
      status: "error",
      providerName: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Usage limit reached",
      updatedAt: EPOCH,
    },
    latestUserMessageAt: EPOCH,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } satisfies OrchestrationThreadShell;

  return {
    snapshotSequence: 1,
    projects: [],
    threads: [thread],
    updatedAt: EPOCH,
  };
}

it.effect("restores a persisted usage-limit timer and resumes at the reset time", () =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command) => Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngineShape;
    const snapshot = makeShellSnapshot();
    const snapshotQuery = {
      getShellSnapshot: () => Effect.succeed(snapshot),
    } as unknown as ProjectionSnapshotQueryShape;
    const layer = UsageLimitAutoResumeReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provideMerge(ServerSettingsService.layerTest()),
    );

    const command = yield* Effect.gen(function* () {
      const reactor = yield* UsageLimitAutoResumeReactor;
      yield* reactor.start();
      yield* TestClock.adjust("1 minute");
      return yield* Queue.take(commands);
    }).pipe(Effect.provide(layer));

    expect(command.type).toBe("thread.usage-limit-wait.resume");
    if (command.type === "thread.usage-limit-wait.resume") {
      expect(command.threadId).toBe(THREAD_ID);
      expect(command.waitId).toBe(WAIT_ID);
    }
  }).pipe(Effect.provide(TestClock.layer())),
);
