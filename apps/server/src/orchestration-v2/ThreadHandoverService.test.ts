import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadHandoverService from "./ThreadHandoverService.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-thread-handover-",
});

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by handover tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:handover-test",
  },
  displayName: "Codex handover test",
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({}),
  } as unknown as import("@t3tools/provider-core/server/driver").ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration:
    {} as import("@t3tools/provider-core/server/driver").ProviderInstance["textGeneration"],
} satisfies import("@t3tools/provider-core/server/driver").ProviderInstance;

const layerHandoverProviderInstances = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed([providerInstance].find((instance) => instanceId === instance.instanceId)),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerHandoverTest = Layer.mergeAll(
  RuntimeLayer.layerProduction,
  RuntimeLayer.layerEventSink,
  EffectOutbox.layer,
).pipe(
  Layer.provide(ProjectStore.layer),
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
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerHandoverProviderInstances),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
      Layer.mock(AnalyticsService.AnalyticsService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
      Layer.mock(PreviewManager.PreviewManager)({}),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
        get: () => Effect.succeed(null),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
    ),
  ),
  Layer.provideMerge(layerPlatformTest),
);

it.layer(layerHandoverTest)("ThreadHandoverService", (it) => {
  const seedSourceThread = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly messageText: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly finalizeRun?: boolean;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const workspaceRoot =
        input.worktreePath ?? (yield* fs.makeTempDirectory({ prefix: "t3-handover-project-" }));
      yield* projects.create({
        commandId: CommandId.make(`${input.threadId}:create-project`),
        projectId: input.projectId,
        title: "Handover project",
        workspaceRoot,
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${input.threadId}:create`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: input.branch,
        worktreePath: input.worktreePath,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${input.threadId}:message`),
        threadId: input.threadId,
        messageId: MessageId.make(`${input.threadId}:message`),
        text: input.messageText,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* outbox.cancelUnsettled({
        threadId: input.threadId,
        effectTypes: ["provider-turn.start"],
        reason: "not under test",
      });
      const projection = yield* orchestrator.getThreadProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.status === "starting");
      assert.isDefined(run);
      if (input.finalizeRun === false) {
        return projection;
      }
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make(`${input.threadId}:finish-run`),
        events: [
          {
            id: EventId.make(`${input.threadId}:run-failed`),
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
        ],
      });
      return yield* orchestrator.getThreadProjection(input.threadId);
    });

  const handover = (input: {
    readonly commandId: CommandId;
    readonly projection: OrchestrationV2ThreadProjection;
    readonly message: string;
    readonly byOwnAgent?: boolean;
  }) =>
    Effect.gen(function* () {
      const handovers = yield* ThreadHandoverService.ThreadHandoverService;
      return yield* handovers.handover({
        commandId: input.commandId,
        projection: input.projection,
        message: input.message,
        byOwnAgent: input.byOwnAgent ?? false,
      });
    });

  it.effect(
    "launches a same-workspace top-level successor with the exact pending message and settles the source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("project:handover:launch");
        const threadId = ThreadId.make("thread:handover:launch");
        const worktreePath = yield* fs.makeTempDirectory({ prefix: "t3-handover-launch-" });
        const projection = yield* seedSourceThread({
          threadId,
          projectId,
          title: "Source thread",
          messageText: "First user ask",
          branch: "feature/launch",
          worktreePath,
        });
        const commandId = CommandId.make("handover-test:launch");
        const message = "Continue exactly here.";

        const result = yield* handover({ commandId, projection, message });
        const handoverId = `handover:${encodeURIComponent(commandId)}`;
        assert.equal(result.handoverId, handoverId);
        assert.equal(
          result.manifestPath,
          path.join(
            config.stateDir,
            "artifacts",
            "projects",
            encodeURIComponent(projectId),
            "threads",
            encodeURIComponent(threadId),
            "handovers",
            encodeURIComponent(handoverId),
            "manifest.json",
          ),
        );
        assert.notEqual(result.threadId, threadId);

        const successor = yield* orchestrator.getThreadProjection(result.threadId);
        assert.equal(successor.thread.lineage.relationshipToParent, null);
        assert.equal(successor.thread.lineage.rootThreadId, result.threadId);
        assert.equal(successor.thread.createdBy, "agent");
        assert.equal(successor.thread.creationSource, "mcp");
        assert.equal(successor.thread.title, "Source thread (handover)");
        assert.equal(successor.thread.worktreePath, worktreePath);
        assert.equal(successor.thread.branch, "feature/launch");
        assert.deepEqual(successor.thread.modelSelection, projection.thread.modelSelection);

        const userMessages = successor.messages.filter((candidate) => candidate.role === "user");
        assert.lengthOf(userMessages, 1);
        const capsulePath = path.join(path.dirname(result.manifestPath), "capsule.md");
        const capsule = yield* fs.readFileString(capsulePath);
        assert.isTrue(capsule.includes("# Thread Handover Timeline"));
        assert.isTrue(capsule.includes("First user ask"));
        assert.isTrue(
          userMessages[0]!.text.startsWith(
            `You are the top-level continuation of thread ${threadId}.`,
          ),
        );
        assert.isTrue(
          userMessages[0]!.text.includes(
            `The complete capsule is at ${capsulePath}; handover metadata is at ${result.manifestPath}.`,
          ),
        );
        assert.isTrue(userMessages[0]!.text.includes("# Handover capsule"));
        assert.isTrue(userMessages[0]!.text.includes(capsule));
        assert.isTrue(userMessages[0]!.text.endsWith(`# Next request\n\n${message}`));

        const manifest = JSON.parse(yield* fs.readFileString(result.manifestPath)) as Record<
          string,
          unknown
        >;
        assert.equal(manifest.version, 1);
        assert.equal(manifest.handoverId, handoverId);
        assert.equal(manifest.commandId, commandId);
        assert.equal(manifest.projectId, projectId);
        assert.equal(manifest.sourceThreadId, threadId);
        assert.equal(manifest.successorThreadId, result.threadId);
        assert.equal(manifest.predecessor, null);
        assert.deepEqual(manifest.predecessorChain, []);
        assert.isNotNull(manifest.launchedAt);
        assert.equal(manifest.capsulePath, capsulePath);

        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(settled.thread.settledAt);
      }),
  );

  it.effect("chains each handover artifact to its predecessor in launch order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:handover:chain");
      const threadId = ThreadId.make("thread:handover:chain");
      const readManifest = (manifestPath: string) =>
        Effect.map(
          fs.readFileString(manifestPath),
          (text) =>
            JSON.parse(text) as {
              readonly handoverId: string;
              readonly successorThreadId: string;
              readonly predecessor: {
                readonly handoverId: string;
                readonly manifestPath: string;
              } | null;
              readonly predecessorChain: ReadonlyArray<{ readonly handoverId: string }>;
            },
        );

      const firstProjection = yield* seedSourceThread({
        threadId,
        projectId,
        title: "Chained source",
        messageText: "Original ask",
        branch: null,
        worktreePath: null,
      });
      const first = yield* handover({
        commandId: CommandId.make("handover-test:chain:1"),
        projection: firstProjection,
        message: "First continuation",
      });
      const firstManifest = yield* readManifest(first.manifestPath);
      assert.equal(firstManifest.predecessor, null);

      yield* TestClock.adjust("1 minute");
      const second = yield* handover({
        commandId: CommandId.make("handover-test:chain:2"),
        projection: yield* orchestrator.getThreadProjection(threadId),
        message: "Second continuation",
      });
      const secondManifest = yield* readManifest(second.manifestPath);
      assert.notEqual(second.threadId, first.threadId);
      assert.equal(secondManifest.predecessor?.handoverId, first.handoverId);
      assert.equal(secondManifest.predecessor?.manifestPath, first.manifestPath);
      assert.deepEqual(
        secondManifest.predecessorChain.map((entry) => entry.handoverId),
        [first.handoverId],
      );

      yield* TestClock.adjust("1 minute");
      const third = yield* handover({
        commandId: CommandId.make("handover-test:chain:3"),
        projection: yield* orchestrator.getThreadProjection(threadId),
        message: "Third continuation",
      });
      const thirdManifest = yield* readManifest(third.manifestPath);
      assert.equal(thirdManifest.predecessor?.handoverId, second.handoverId);
      assert.deepEqual(
        thirdManifest.predecessorChain.map((entry) => entry.handoverId),
        [first.handoverId, second.handoverId],
      );
    }),
  );

  it.effect("replays a command retry from the recorded manifest instead of launching again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:handover:retry");
      const threadId = ThreadId.make("thread:handover:retry");
      const commandId = CommandId.make("handover-test:retry");
      const projection = yield* seedSourceThread({
        threadId,
        projectId,
        title: "Retry source",
        messageText: "Retry ask",
        branch: null,
        worktreePath: null,
      });
      const path = yield* Path.Path;
      const capsulePath = (manifestPath: string) =>
        path.join(path.dirname(manifestPath), "capsule.md");

      const first = yield* handover({ commandId, projection, message: "Exact next request" });
      const manifestBefore = yield* fs.readFileString(first.manifestPath);
      const capsuleBefore = yield* fs.readFileString(capsulePath(first.manifestPath));
      const shellBefore = yield* orchestrator.getShellSnapshot();
      const threadsBefore = [...shellBefore.threads, ...shellBefore.archivedThreads].filter(
        (thread) => thread.projectId === projectId,
      ).length;

      yield* TestClock.adjust("1 minute");
      const retry = yield* handover({
        commandId,
        projection: yield* orchestrator.getThreadProjection(threadId),
        message: "Exact next request",
      });

      assert.equal(retry.threadId, first.threadId);
      assert.equal(retry.handoverId, first.handoverId);
      assert.equal(retry.manifestPath, first.manifestPath);
      assert.equal(yield* fs.readFileString(first.manifestPath), manifestBefore);
      assert.equal(yield* fs.readFileString(capsulePath(first.manifestPath)), capsuleBefore);
      const shellAfter = yield* orchestrator.getShellSnapshot();
      const threadsAfter = [...shellAfter.threads, ...shellAfter.archivedThreads].filter(
        (thread) => thread.projectId === projectId,
      ).length;
      assert.equal(threadsAfter, threadsBefore);
    }),
  );

  it.effect("rejects active runs and delegated work before any launch", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const activeThreadId = ThreadId.make("thread:handover:reject:active");
      const activeProjection = yield* seedSourceThread({
        threadId: activeThreadId,
        projectId: ProjectId.make("project:handover:reject:active"),
        title: "Active source",
        messageText: "Active ask",
        branch: null,
        worktreePath: null,
        finalizeRun: false,
      });
      const activeError = yield* handover({
        commandId: CommandId.make("handover-test:reject:active"),
        projection: activeProjection,
        message: "Should never launch",
      }).pipe(Effect.flip);
      assert.equal(activeError._tag, "ThreadHandoverRejectedError");
      if (activeError._tag === "ThreadHandoverRejectedError") {
        assert.equal(activeError.reason, "An active run can be handed over only by its own agent.");
      }

      const delegatedThreadId = ThreadId.make("thread:handover:reject:delegated");
      const delegatedProjection = yield* seedSourceThread({
        threadId: delegatedThreadId,
        projectId: ProjectId.make("project:handover:reject:delegated"),
        title: "Delegated source",
        messageText: "Delegated ask",
        branch: null,
        worktreePath: null,
      });
      const run = delegatedProjection.runs[0];
      assert.isDefined(run);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("handover-test:reject:delegated:seed"),
        events: [
          {
            id: EventId.make("handover-test:reject:delegated:subagent"),
            type: "subagent.updated",
            threadId: delegatedThreadId,
            occurredAt: now,
            payload: {
              id: NodeId.make("node:handover:reject:delegated"),
              threadId: delegatedThreadId,
              runId: run.id,
              parentNodeId: run.rootNodeId ?? NodeId.make("node:handover:reject:delegated:parent"),
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Finish delegated work",
              title: null,
              model: null,
              status: "pending",
              result: null,
              startedAt: null,
              completedAt: null,
              updatedAt: now,
            },
          },
        ],
      });
      const delegatedError = yield* handover({
        commandId: CommandId.make("handover-test:reject:delegated"),
        projection: yield* orchestrator.getThreadProjection(delegatedThreadId),
        message: "Should never launch",
      }).pipe(Effect.flip);
      assert.equal(delegatedError._tag, "ThreadHandoverRejectedError");
      if (delegatedError._tag === "ThreadHandoverRejectedError") {
        assert.equal(
          delegatedError.reason,
          "Wait for delegated and background work to finish before handing over.",
        );
      }
    }),
  );
});
