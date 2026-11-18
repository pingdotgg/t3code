import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as GroupReportReactor from "./GroupReportReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-group-report-",
});

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatformTest),
    ),
  ),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by group report tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
  EffectOutbox.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      refreshRepositoryIdentity: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

const layerReactorTest = GroupReportReactor.layer.pipe(Layer.provideMerge(layerTest));

const projectId = ProjectId.make("project:group-report");

const harness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const reactor = yield* GroupReportReactor.GroupReportReactor;
  const projects = yield* ProjectService.ProjectService;
  yield* projects.create({
    commandId: CommandId.make("command:group-report:project"),
    projectId,
    title: "Group report",
    workspaceRoot: "/workspace/group-report",
  });

  const thread = (name: string) => ThreadId.make(`thread:group-report:${name}`);
  const create = (name: string, lead?: ThreadId) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:group-report:create:${name}`),
      threadId: thread(name),
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(lead === undefined ? {} : { groupParentThreadId: lead }),
    });
  const latestRun = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.map(({ runs }) => runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!));
  const startTurn = (threadId: ThreadId, text: string) =>
    orchestrator
      .dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:group-report:send:${threadId}:${text}`),
        threadId,
        messageId: MessageId.make(`message:group-report:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      })
      .pipe(Effect.andThen(latestRun(threadId)));
  /** Ends the run the way a provider does: its reply, then the run's final status. */
  const endTurn = (
    run: OrchestrationV2Run,
    status: OrchestrationV2Run["status"],
    reply?: string,
    before: ReadonlyArray<OrchestrationV2DomainEvent> = [],
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ended = {
        id: EventId.make(`event:group-report:${run.id}:${status}`),
        type: "run.updated",
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          ...run,
          status,
          startedAt: run.startedAt ?? now,
          completedAt: status === "waiting" ? null : now,
        },
      } satisfies OrchestrationV2DomainEvent;
      yield* sink.write({
        events: [
          ...before,
          ...(reply === undefined
            ? []
            : [
                {
                  id: EventId.make(`event:group-report:${run.id}:reply`),
                  type: "message.updated",
                  threadId: run.threadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: {
                    id: MessageId.make(`message:group-report:${run.id}:reply`),
                    threadId: run.threadId,
                    runId: run.id,
                    nodeId: null,
                    role: "assistant",
                    text: reply,
                    attachments: [],
                    streaming: false,
                    createdBy: "agent",
                    creationSource: "provider",
                    createdAt: now,
                    updatedAt: now,
                  },
                } satisfies OrchestrationV2DomainEvent,
              ]),
          ended,
        ],
      });
      return ended;
    });
  const reports = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(
        Effect.map(({ messages }) =>
          messages.filter((message) => message.notification?.source.kind === "group_worker"),
        ),
      );
  return { orchestrator, projections, sink, reactor, thread, create, startTurn, endTurn, reports };
});

it.effect("reports a finished worker to its idle lead", () =>
  Effect.gen(function* () {
    const { projections, reactor, thread, create, startTurn, endTurn, reports } = yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const run = yield* startTurn(thread("worker"), "Build the parser");
    yield* reactor.handle(yield* endTurn(run, "waiting", "The parser is done."));

    const [report] = yield* reports(thread("lead"));
    assert.deepEqual(report?.notification, {
      source: { kind: "group_worker", workerThreadIds: [thread("worker")] },
      outcome: "completed",
      summary: "worker finished",
      detail: `worker [finished] (threadId ${thread("worker")}):\nThe parser is done.`,
    });
    assert.equal(report?.text, report?.notification?.detail);
    const { runs } = yield* projections.getThreadRecords(thread("lead"), ["runs"]);
    assert.deepEqual(
      runs.map((leadRun) => [leadRun.userMessageId, leadRun.status]),
      [[report!.id, "starting"]],
    );
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("merges reports while the lead is busy", () =>
  Effect.gen(function* () {
    const { projections, sink, reactor, thread, create, startTurn, endTurn, reports } =
      yield* harness;
    yield* create("lead");
    yield* create("w1", thread("lead"));
    yield* create("w2", thread("lead"));
    const leadRun = yield* startTurn(thread("lead"), "Coordinate");
    const w1 = yield* startTurn(thread("w1"), "First half");
    const w2 = yield* startTurn(thread("w2"), "Second half");
    yield* reactor.handle(yield* endTurn(w1, "waiting", "First half done."));
    yield* reactor.handle(yield* endTurn(w2, "failed", "x".repeat(2_500)));

    const [queued] = yield* reports(thread("lead"));
    assert.deepEqual(queued?.notification?.source, {
      kind: "group_worker",
      workerThreadIds: [thread("w1"), thread("w2")],
    });
    assert.equal(queued?.notification?.summary, "2 workers reported");
    assert.equal(
      queued?.text,
      [
        `w1 [finished] (threadId ${thread("w1")}):\nFirst half done.`,
        `w2 [failed] (threadId ${thread("w2")}):\n${"x".repeat(2_000)}…\nRead the rest with t3_thread_read.`,
      ].join("\n\n"),
    );

    // A later run of a reported worker replaces its section instead of adding one.
    const w2Again = yield* startTurn(thread("w2"), "Retry the second half");
    yield* reactor.handle(yield* endTurn(w2Again, "waiting", "Second half done."));
    const [merged, ...others] = yield* reports(thread("lead"));
    assert.lengthOf(others, 0);
    assert.equal(merged?.notification?.summary, "2 workers finished");
    assert.equal(merged?.notification?.outcome, "completed");
    assert.equal(
      merged?.text,
      [
        `w1 [finished] (threadId ${thread("w1")}):\nFirst half done.`,
        `w2 [finished] (threadId ${thread("w2")}):\nSecond half done.`,
      ].join("\n\n"),
    );

    const afterSequence = yield* sink.latestSequence();
    yield* endTurn(leadRun, "completed");
    const started = yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.threadId === thread("lead") &&
          stored.event.payload.userMessageId === merged!.id &&
          stored.event.payload.status !== "queued",
      ),
      Stream.runHead,
    );
    assert.isTrue(started._tag === "Some");
    const { runs } = yield* projections.getThreadRecords(thread("lead"), ["runs"]);
    assert.deepEqual(
      runs.filter((run) => run.id !== leadRun.id).map((run) => run.userMessageId),
      [merged!.id],
    );
    const { messages } = yield* projections.getThreadRecords(thread("lead"), ["messages"], {
      messageIds: [merged!.id],
    });
    assert.deepEqual(messages[0]?.notification?.source, {
      kind: "group_worker",
      workerThreadIds: [thread("w1"), thread("w2")],
    });
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("sends no report while a worker waits for an answer", () =>
  Effect.gen(function* () {
    const { reactor, thread, create, startTurn, endTurn, reports } = yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const run = yield* startTurn(thread("worker"), "Ask first");
    const now = yield* DateTime.now;
    const question = {
      id: EventId.make("event:group-report:question"),
      type: "runtime-request.updated",
      threadId: run.threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:group-report:question"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* reactor.handle(yield* endTurn(run, "waiting", "Which parser?", [question]));
    assert.lengthOf(yield* reports(thread("lead")), 0);
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("sends no report for an interrupted worker", () =>
  Effect.gen(function* () {
    const { reactor, thread, create, startTurn, endTurn, reports } = yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const run = yield* startTurn(thread("worker"), "Stop me");
    yield* reactor.handle(yield* endTurn(run, "interrupted", "Partial work."));
    assert.lengthOf(yield* reports(thread("lead")), 0);
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("wakes a snoozed lead", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, reactor, thread, create, startTurn, endTurn, reports } =
      yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("command:group-report:snooze"),
      threadId: thread("lead"),
      snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 4 })),
    });
    assert.isNotNull((yield* projections.getThreadRecords(thread("lead"), [])).thread.snoozedUntil);
    const run = yield* startTurn(thread("worker"), "Build it");
    yield* reactor.handle(yield* endTurn(run, "waiting", "Built."));
    assert.lengthOf(yield* reports(thread("lead")), 1);
    assert.isNull((yield* projections.getThreadRecords(thread("lead"), [])).thread.snoozedUntil);
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("sends no report to an archived lead", () =>
  Effect.gen(function* () {
    const { orchestrator, reactor, thread, create, startTurn, endTurn, reports } = yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:group-report:archive"),
      threadId: thread("lead"),
    });
    const run = yield* startTurn(thread("worker"), "Build it");
    yield* reactor.handle(yield* endTurn(run, "waiting", "Built."));
    assert.lengthOf(yield* reports(thread("lead")), 0);
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("does not report twice for one run", () =>
  Effect.gen(function* () {
    const { reactor, thread, create, startTurn, endTurn, reports } = yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const run = yield* startTurn(thread("worker"), "Build it");
    const waiting = yield* endTurn(run, "waiting", "Built.");
    yield* reactor.handle(waiting);
    yield* reactor.handle(waiting);
    // The checkpoint then completes the same run.
    yield* reactor.handle(
      yield* endTurn({ ...run, startedAt: waiting.payload.startedAt }, "completed"),
    );
    assert.lengthOf(yield* reports(thread("lead")), 1);
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("reports a failed worker whose next message is held in the queue", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, reactor, thread, create, startTurn, endTurn, reports } =
      yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const run = yield* startTurn(thread("worker"), "Build it");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:group-report:queue-next"),
      threadId: thread("worker"),
      messageId: MessageId.make("message:group-report:queue-next"),
      text: "Then test it",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
    const { runs } = yield* projections.getThreadRecords(thread("worker"), ["runs"]);
    const queued = runs.find((candidate) => candidate.status === "queued")!;
    const now = yield* DateTime.now;
    // After a provider failure the queue is held until the user resumes it.
    const held = {
      id: EventId.make("event:group-report:held"),
      type: "run.updated",
      threadId: queued.threadId,
      runId: queued.id,
      occurredAt: now,
      payload: { ...queued, queueHeld: true },
    } satisfies OrchestrationV2DomainEvent;
    yield* reactor.handle(yield* endTurn(run, "failed", "The provider failed.", [held]));
    const [report] = yield* reports(thread("lead"));
    assert.equal(report?.notification?.outcome, "failed");
  }).pipe(Effect.provide(layerReactorTest)),
);

it.effect("reports a worker's success after its failed run is retried", () =>
  Effect.gen(function* () {
    const { reactor, thread, create, startTurn, endTurn, reports } = yield* harness;
    yield* create("lead");
    yield* create("worker", thread("lead"));
    const run = yield* startTurn(thread("worker"), "Build it");
    const failed = yield* endTurn(run, "failed");
    yield* reactor.handle(failed);
    // A workspace-preparation retry runs the same run id again.
    yield* reactor.handle(
      yield* endTurn({ ...run, startedAt: failed.payload.startedAt }, "waiting", "Built."),
    );
    assert.deepEqual(
      (yield* reports(thread("lead"))).map((report) => report.notification?.outcome),
      ["failed", "completed"],
    );
  }).pipe(Effect.provide(layerReactorTest)),
);
