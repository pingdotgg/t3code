// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { describe, expect, it } from "@effect/vitest";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { childReportStatesFrom, unrecordedChildReportState } from "./childReportState.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const activity = (kind: string, payload: unknown): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${kind}-${JSON.stringify(payload)}`),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("childReportStatesFrom", () => {
  it("restores each child from its newest row carrying report state", () => {
    const states = childReportStatesFrom([
      activity("task.started", { taskId: "sub.p.a", reportBack: false }),
      activity("task.started", { taskId: "sub.p.b", reportBack: true }),
      activity("task.progress", { taskId: "sub.p.b", reportBack: true, reportedMessageId: "m1" }),
      activity("task.updated", { taskId: "sub.p.b", status: "running" }),
      activity("task.progress", { taskId: "sub.p.b", reportBack: true, reportedMessageId: "m2" }),
      activity("task.progress", { taskId: "sub.p.c", reportBack: false }),
    ]);
    expect(Object.fromEntries(states)).toEqual({
      "sub.p.a": { reportBack: false, lastReported: null },
      "sub.p.b": { reportBack: true, lastReported: "m2" },
      "sub.p.c": { reportBack: false, lastReported: null },
    });
  });

  it("omits children whose rows carry no report state", () => {
    expect(childReportStatesFrom([activity("task.started", { taskId: "sub.p.old" })]).size).toBe(0);
  });

  it("treats an unrecorded child's existing reply as already reported", () => {
    expect(unrecordedChildReportState("m9")).toEqual({ reportBack: true, lastReported: "m9" });
    expect(unrecordedChildReportState(null)).toEqual({ reportBack: true, lastReported: null });
  });
});

const PROJECT_ID = ProjectId.make("project-restart");
const PARENT_ID = ThreadId.make("parent-restart");
const NOW = "2026-01-01T00:00:00.000Z";

let commandCount = 0;
const commandId = () => CommandId.make(`test-restart-${++commandCount}`);

/** One server process: real engine and projections over a SQLite file, plus the toolkit. */
const serverLayer = (databasePath: string) => {
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-child-restart-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(
    orchestration,
    ServerSettingsService.layerTest(),
    Layer.mock(ProviderService.ProviderService)({
      getInstanceInfo: (instanceId) =>
        Effect.succeed({
          instanceId,
          driverKind: "codex",
          displayName: undefined,
          enabled: true,
        } as never),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  );
  return Layer.mergeAll(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies)), dependencies);
};

/** Runs `body` against a fresh server on `databasePath`; the server stops when it ends. */
const withServer = <A, E, R>(databasePath: string, body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provide(serverLayer(databasePath)));

const spawnChild = (reportBack: boolean) =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadsToolkit;
    return yield* toolkit.handle("spawn_thread", { task: "Remember HERON.", reportBack }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)["spawn_thread"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-restart"),
        threadId: PARENT_ID,
        providerSessionId: "provider-session-restart",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        issuedAt: 1,
      }),
    );
  });

/** Runs `act`, then waits for the first domain event matching `until`. */
const dispatchUntil = <A, E, R>(
  act: Effect.Effect<A, E, R>,
  until: (event: OrchestrationEvent) => boolean,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const events = yield* engine.subscribeDomainEvents;
      const result = yield* act;
      const event = yield* events.pipe(
        Stream.filter(until),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      return { result, event };
    }),
  );

const dispatchAll = (
  commands: ReadonlyArray<Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0]>,
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    for (const command of commands) yield* engine.dispatch(command);
  });

const parentMessages = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  return Option.getOrThrow(yield* snapshots.getThreadDetailById(PARENT_ID)).messages;
});

const session = (threadId: ThreadId, status: "running" | "ready", turnId: string | null) =>
  ({
    type: "thread.session.set",
    commandId: commandId(),
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: turnId === null ? null : TurnId.make(turnId),
      lastError: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
  }) as const;

const assistantReply = (threadId: ThreadId, messageId: string, text: string) =>
  [
    {
      type: "thread.message.assistant.delta",
      commandId: commandId(),
      threadId,
      messageId: MessageId.make(messageId),
      delta: text,
      createdAt: NOW,
    },
    {
      type: "thread.message.assistant.complete",
      commandId: commandId(),
      threadId,
      messageId: MessageId.make(messageId),
      createdAt: NOW,
    },
  ] as const;

const parentActivity =
  (childId: string, kind: string, status?: string) => (event: OrchestrationEvent) =>
    event.type === "thread.activity-appended" &&
    event.aggregateId === PARENT_ID &&
    event.payload.activity.kind === kind &&
    (event.payload.activity.payload as { taskId?: string }).taskId === childId &&
    (status === undefined ||
      (event.payload.activity.payload as { status?: string }).status === status);

const reportsOf = (messages: ReadonlyArray<{ role: string; text: string }>) =>
  messages.filter((message) => message.role === "user" && message.text.includes("finished a turn"));

describe("child report-back across a server restart", () => {
  it.effect("keeps reporting a child's finished turns to its parent, once each", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-child-restart-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");

      // First process: the parent spawns one child that reports back and one that does not.
      const [childId, quietId] = yield* withServer(
        databasePath,
        Effect.gen(function* () {
          yield* dispatchAll([
            {
              type: "project.create",
              commandId: commandId(),
              projectId: PROJECT_ID,
              title: "Restart",
              workspaceRoot: directory,
              createdAt: NOW,
            },
            {
              type: "thread.create",
              commandId: commandId(),
              threadId: PARENT_ID,
              projectId: PROJECT_ID,
              title: "Parent",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: NOW,
            },
          ]);
          const taskStarted = (event: OrchestrationEvent) =>
            event.type === "thread.activity-appended" &&
            event.aggregateId === PARENT_ID &&
            event.payload.activity.kind === "task.started";
          const loud = yield* dispatchUntil(spawnChild(true), taskStarted);
          const quiet = yield* dispatchUntil(spawnChild(false), taskStarted);
          return [loud.result.threadId, quiet.result.threadId] as const;
        }),
      );
      const child = ThreadId.make(childId);
      const quietChild = ThreadId.make(quietId);

      // Second process: both children finish a turn after the restart. The
      // quiet child goes first; the bridge handles events in order, so a
      // report from it would reach the parent before the loud child's.
      const { quietIdle, report } = yield* withServer(
        databasePath,
        Effect.gen(function* () {
          const { event: quietIdle } = yield* dispatchUntil(
            dispatchAll([
              session(quietChild, "running", "quiet-turn-1"),
              ...assistantReply(quietChild, "quiet-reply-1", "QUIET"),
              session(quietChild, "ready", null),
            ]),
            parentActivity(quietId, "task.progress", "idle"),
          );
          const { event: report } = yield* dispatchUntil(
            dispatchAll([
              session(child, "running", "turn-1"),
              ...assistantReply(child, "reply-1", "HERON"),
              session(child, "ready", null),
            ]),
            (event) =>
              event.type === "thread.message-sent" &&
              event.aggregateId === PARENT_ID &&
              event.payload.text.includes("finished a turn"),
          );
          return { quietIdle, report };
        }),
      );
      expect(
        quietIdle.type === "thread.activity-appended" && quietIdle.payload.activity.payload,
      ).toMatchObject({ reportBack: false });
      expect(report.type === "thread.message-sent" && report.payload.text).toContain("HERON");

      // Third process: an idle transition without a new reply is not reported
      // again, and the quiet child was never reported.
      const messages = yield* withServer(
        databasePath,
        Effect.gen(function* () {
          yield* dispatchUntil(
            dispatchAll([session(child, "running", "turn-2"), session(child, "ready", null)]),
            parentActivity(childId, "task.progress", "idle"),
          );
          // The bridge handles events in order, so once this row lands any report
          // for the idle transition above has already been dispatched.
          yield* dispatchUntil(
            dispatchAll([session(child, "running", "turn-3")]),
            parentActivity(childId, "task.updated", "running"),
          );
          return yield* parentMessages;
        }),
      );
      expect(reportsOf(messages).map((message) => message.text)).toEqual([
        expect.stringContaining("HERON"),
      ]);
    }).pipe(Effect.scoped),
  );
});
