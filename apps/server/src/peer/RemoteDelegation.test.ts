import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type RepositoryIdentity,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";

// The laptop's agent delegates a task to the box through a link. The box is
// its real /mcp behind real OAuth, with one thread the test finishes; the
// laptop is its real orchestrator and toolkits. The parent here wakes as it
// would for a local child.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };

type LaunchedWith = Pick<
  ThreadLaunch.ThreadLaunchInput,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;

/** The thread the box launches for the task, which the test finishes. */
interface BoxThread {
  readonly launched: Ref.Ref<ThreadId | null>;
  /** The link session that launched it, as the box stamps it. */
  readonly linkOrigin: Ref.Ref<{ readonly sessionId: string; readonly label: string } | null>;
  /** The parent the launch names, so the thread there can link back to it. */
  readonly delegatedFrom: Ref.Ref<ThreadLaunch.ThreadLaunchInput["delegatedFrom"] | null>;
  /** The model and modes it was launched with. */
  readonly launchedWith: Ref.Ref<LaunchedWith | null>;
  /** The first message the thread there was launched with. */
  readonly message: Ref.Ref<string | null>;
  readonly status: Ref.Ref<OrchestrationV2Run["status"]>;
  readonly reply: Ref.Ref<string>;
  /** A later run's reply, after the task's own, as a follow-up message would leave. */
  readonly laterReply: Ref.Ref<string | null>;
  /** The run each wait asked for, in order. */
  readonly waitedFor: Ref.Ref<ReadonlyArray<RunId | undefined>>;
  /** Waiting there fails with this, as a thread deleted there does. */
  readonly gone: Ref.Ref<boolean>;
  readonly interrupted: Ref.Ref<number>;
  /** What each interrupt or stop there did, once per command id. */
  readonly stops: Ref.Ref<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>;
  /** The launch starts no run, as one recorded before its run was kept. */
  readonly runless: Ref.Ref<boolean>;
  /** Completed on the first interrupt there. */
  readonly interruptedOnce: Deferred.Deferred<void>;
  readonly finished: Deferred.Deferred<void>;
  /** While set, reading the thread there waits: completed once a read starts, released by `releaseRead`. */
  readonly holdRead: Ref.Ref<boolean>;
  readonly readStarted: Deferred.Deferred<void>;
  readonly releaseRead: Deferred.Deferred<void>;
}

const makeBoxThread = Effect.gen(function* () {
  return {
    launched: yield* Ref.make<ThreadId | null>(null),
    linkOrigin: yield* Ref.make<{ readonly sessionId: string; readonly label: string } | null>(
      null,
    ),
    delegatedFrom: yield* Ref.make<ThreadLaunch.ThreadLaunchInput["delegatedFrom"] | null>(null),
    launchedWith: yield* Ref.make<LaunchedWith | null>(null),
    message: yield* Ref.make<string | null>(null),
    status: yield* Ref.make<OrchestrationV2Run["status"]>("running"),
    reply: yield* Ref.make("Working…"),
    laterReply: yield* Ref.make<string | null>(null),
    waitedFor: yield* Ref.make<ReadonlyArray<RunId | undefined>>([]),
    gone: yield* Ref.make(false),
    interrupted: yield* Ref.make(0),
    stops: yield* Ref.make<ReadonlyArray<"interrupt" | "thread.stop" | "delegated-tasks">>([]),
    runless: yield* Ref.make(false),
    interruptedOnce: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<void>(),
    holdRead: yield* Ref.make(false),
    readStarted: yield* Deferred.make<void>(),
    releaseRead: yield* Deferred.make<void>(),
  } satisfies BoxThread;
});

const serveBox = (thread: BoxThread) => {
  return servePeer(box, boxToolkitLayer(thread));
};

const boxRunId = RunId.make("run:box");
const boxLaterRunId = RunId.make("run:box-later");

const boxToolkitLayer = (thread: BoxThread) => {
  const runId = boxRunId;
  const interrupts = new Set<string>();
  const shellOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(thread.launched)) !== threadId) return null;
      const linkOrigin = yield* Ref.get(thread.linkOrigin);
      return {
        ...liveThreadShell(threadId, { runtimeMode: "full-access" }),
        projectId: boxProject,
        ...(linkOrigin === null ? {} : { linkOrigin }),
      };
    });
  const runOf = (status: OrchestrationV2Run["status"]) =>
    ({
      id: runId,
      threadId: ThreadId.make("thread:box"),
      ordinal: 1,
      status,
      modelSelection,
      requestedAt: DateTime.makeUnsafe(0),
      startedAt: DateTime.makeUnsafe(0),
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const projectionOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(threadId);
      const status = yield* Ref.get(thread.status);
      const runless = yield* Ref.get(thread.runless);
      return shell === null
        ? (null as never)
        : { ...idleThreadProjection(shell), runs: runless ? [] : [runOf(status)] };
    });
  // One record per command id, as its receipt replays a repeat.
  const recordStop = (commandId: string, kind: "interrupt" | "thread.stop" | "delegated-tasks") =>
    Effect.gen(function* () {
      if (interrupts.has(`${kind}:${commandId}`)) return;
      interrupts.add(`${kind}:${commandId}`);
      yield* Ref.update(thread.stops, (seen) => [...seen, kind]);
      if (kind !== "delegated-tasks") {
        yield* Ref.update(thread.interrupted, (count) => count + 1);
        yield* Deferred.succeed(thread.interruptedOnce, undefined);
      }
    });
  const layerBoxThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    waitForThread: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(thread.waitedFor, (seen) => [...seen, input.runId]);
        // A thread with no run has nothing to wait for.
        if (yield* Ref.get(thread.runless)) {
          return { threadId: input.threadId, run: null, timedOut: false };
        }
        if (yield* Ref.get(thread.gone)) {
          return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
            projectId: boxProject,
            threadId: input.threadId,
          });
        }
        const done = yield* Deferred.await(thread.finished).pipe(
          Effect.timeoutOption(input.timeoutMs),
        );
        // Unpinned, a wait reports the latest run: a later one once there is one.
        const later = input.runId === undefined && (yield* Ref.get(thread.laterReply)) !== null;
        return {
          threadId: input.threadId,
          run: {
            id: later ? boxLaterRunId : runId,
            status: later ? "completed" : yield* Ref.get(thread.status),
          } as OrchestrationV2Run,
          timedOut: Option.isNone(done),
        };
      }),
    getTimelinePage: (threadId, options) =>
      Effect.gen(function* () {
        if (yield* Ref.get(thread.holdRead)) {
          yield* Deferred.succeed(thread.readStarted, undefined);
          yield* Deferred.await(thread.releaseRead);
        }
        const reply = yield* Ref.get(thread.reply);
        const later = yield* Ref.get(thread.laterReply);
        // One assistant message per page, so a read has to page to find the task's.
        const replies = [
          { id: TurnItemId.make("item:reply"), runId, text: reply },
          ...(later === null
            ? []
            : [{ id: TurnItemId.make("item:later-reply"), runId: boxLaterRunId, text: later }]),
        ].map((entry, position) => ({ ...entry, position }));
        const matching =
          options.itemId === undefined
            ? replies.filter((entry) => entry.position > (options.afterPosition ?? -1)).slice(0, 1)
            : replies.filter((entry) => entry.id === options.itemId);
        return {
          items: matching.map(({ id, runId: itemRunId, text, position }) => ({
            position,
            visibility: "local" as const,
            sourceThreadId: threadId,
            sourceItemId: id,
            item: {
              id,
              threadId,
              runId: itemRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed" as const,
              title: null,
              startedAt: DateTime.makeUnsafe(0),
              completedAt: DateTime.makeUnsafe(0),
              updatedAt: DateTime.makeUnsafe(0),
              type: "assistant_message" as const,
              messageId: MessageId.make(`message:${id}`),
              text,
              streaming: false,
            } as never,
          })),
          totalItems: replies.length,
          hasMore:
            options.itemId === undefined &&
            matching.length > 0 &&
            matching.at(-1)!.position < replies.length - 1,
        };
      }),
    interruptThread: (input) =>
      recordStop(input.commandId, "interrupt").pipe(
        Effect.as({ type: "interrupt_requested", run: runOf("running") } as never),
      ),
    dispatch: (command) =>
      command.type === "thread.stop"
        ? recordStop(command.commandId, "thread.stop").pipe(
            Effect.as({ sequence: 0, storedEvents: [] } as never),
          )
        : Effect.die(`The box does not expect ${command.type}`),
    stopDelegatedTasks: (input) => recordStop(input.commandId, "delegated-tasks"),
  });
  const layerBoxLaunches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.get(thread.runless).pipe(
        Effect.flatMap((runless) =>
          Ref.set(thread.launched, input.threadId!).pipe(
            Effect.andThen(Ref.set(thread.linkOrigin, input.linkOrigin ?? null)),
            Effect.andThen(Ref.set(thread.delegatedFrom, input.delegatedFrom ?? null)),
            Effect.andThen(Ref.set(thread.message, input.initialMessage?.text ?? null)),
            Effect.andThen(
              Ref.set(thread.launchedWith, {
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
              }),
            ),
            Effect.as({
              threadId: input.threadId,
              projection: {
                thread: {
                  id: input.threadId,
                  projectId: input.projectId,
                  title: input.title,
                  modelSelection: input.modelSelection,
                },
                runs:
                  input.initialMessage?.messageId && !runless
                    ? [
                        {
                          id: runId,
                          status: "running",
                          userMessageId: input.initialMessage.messageId,
                        },
                      ]
                    : [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult),
          ),
        ),
      ),
  });
  return Layer.merge(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.layerProjectRegistration,
  ).pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(layerBoxThreads),
    Layer.provide(layerBoxLaunches),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-delegation-box-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        snapshot: Effect.succeed({
          // More than a page, so finding the project with this repository pages.
          projects: [
            ...Array.from({ length: 120 }, (_, index) => ({
              id: ProjectId.make(`project:box-other-${index}`),
              title: `other ${index}`,
              workspaceRoot: `/srv/other-${index}`,
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
              deletedAt: null,
            })),
            {
              id: boxProject,
              title: "app",
              workspaceRoot: "/srv/app",
              // Blank until enrichment runs; the list resolves it.
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          updatedAt: "2026-10-01T00:00:00.000Z",
        }),
      }),
    ),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) =>
          Effect.succeed(
            cwd === "/srv/app"
              ? ({
                  canonicalKey: "github.com/acme/app",
                  locator: {
                    source: "git-remote",
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/app.git",
                  },
                } as RepositoryIdentity)
              : null,
          ),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "remote-delegation", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "remote-delegation", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapterV2Shape;

/**
 * The laptop: a real orchestrator (in-memory SQLite) whose parent thread has
 * a live run, the real orchestrator toolkit, and RemoteDelegation. Built in
 * its own scope so a test can tear it down and build it again on the same
 * database, as a restart does.
 */
const makeLaptop = (
  database: Context.Context<SqlClient.SqlClient>,
  offers: Ref.Ref<ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>>,
  /** The laptop's links from before a restart, which keep their sessions there. */
  kept?: Context.Context<Layer.Success<ReturnType<typeof layerLinkingEnvironment>>>,
) =>
  Effect.gen(function* () {
    const linking = kept ?? (yield* layerLinkingEnvironment(laptop).pipe(Layer.build));
    const layerDatabase = Layer.succeedContext(database);
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "remote-delegation-laptop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Ref.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        }),
      ),
    );
    const layerThreads = ThreadManagement.layer.pipe(Layer.provideMerge(layerOrchestrator));
    const layerHere = McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(
        RemoteDelegation.layer.pipe(
          Layer.provideMerge(PeerForwarding.layer),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              // A cold enrichment cache: the project itself reports no identity yet.
              getById: () =>
                Effect.succeed(
                  Option.some({ workspaceRoot: "/home/me/app", repositoryIdentity: null } as never),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) =>
                Effect.succeed(
                  cwd === "/home/me/app"
                    ? ({ canonicalKey: "github.com/acme/app" } as RepositoryIdentity)
                    : null,
                ),
            }),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(layerThreads),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    const server = Context.get(here, McpServer.McpServer);
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      orchestrator: Context.get(here, Orchestrator.OrchestratorV2),
      remote: Context.get(here, RemoteDelegation.RemoteDelegation),
      threads: Context.get(here, ThreadManagement.ThreadManagementService),
      projections: Context.get(here, ProjectionStore.ProjectionStoreV2),
      sink: Context.get(here, EventSink.EventSinkV2),
      call: (name: string, args: Record<string, unknown>, scope = parentScope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          ),
    };
  });

const parentThreadId = ThreadId.make("thread:laptop-parent");
const parentRunId = RunId.make("run:laptop-parent");
const parentRootNode = NodeId.make("node:laptop-parent:root");
const parentScope: McpInvocationContext.McpInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "provider-session:laptop-parent",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:laptop-parent",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The laptop's parent thread, mid-turn when its agent delegates. */
const seedParent = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:laptop-parent");
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:laptop"),
      title: "Laptop parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* laptopEnv.sink.write({
      commandId: CommandId.make("command:seed:laptop-parent"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread:laptop-parent"),
          type: "provider-thread.updated",
          threadId: parentThreadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: parentThreadId,
            ownerNodeId: parentRootNode,
            nativeThreadRef: { driver, nativeId: "native:laptop-parent", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-node:laptop-parent"),
          type: "node.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRootNode,
            threadId: parentThreadId,
            runId: parentRunId,
            parentNodeId: null,
            rootNodeId: parentRootNode,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:seed-run:laptop-parent"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRunId,
            threadId: parentThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:seed-user:laptop-parent"),
            rootNodeId: parentRootNode,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const delegateToBox = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  laptopEnv
    .call("delegate_task", {
      task: "Run the full suite on the box.",
      target: {
        environmentId: box.environmentId,
        providerInstanceId: instanceId,
        model: "gpt-5.4",
      },
      mode: "async",
      clientRequestId: "suite-on-box",
    })
    .pipe(
      Effect.map((result) => {
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        return result.structuredContent as {
          taskId: NodeId;
          status: string;
          childThreadId: null;
          remoteChild: { environmentId: string; threadId: ThreadId; label: string };
        };
      }),
    );

/** Waits until the task here has the result its thread there ended with. */
const taskResult = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>, taskId: NodeId) =>
  laptopEnv.orchestrator
    .streamStoredEventsFrom({
      threadId: parentThreadId,
      afterSequence: 0,
      eventType: "subagent.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.result !== null,
      ),
      Stream.runHead,
      Effect.map((stored) =>
        Option.isSome(stored) && stored.value.event.type === "subagent.updated"
          ? stored.value.event.payload
          : undefined,
      ),
    );

it.effect("a task delegated to the box wakes the laptop's parent when it ends there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      expect(delegated).toMatchObject({
        status: "running",
        childThreadId: null,
        remoteChild: { environmentId: box.environmentId, label: "Box" },
      });
      // The box launched it in the project with the same repository.
      expect(yield* Ref.get(thread.launched)).toBe(delegated.remoteChild.threadId);
      // ...naming the parent here, so the thread there links back to it.
      expect(yield* Ref.get(thread.delegatedFrom)).toEqual({
        environmentId: laptop.environmentId,
        threadId: parentThreadId,
        title: "Laptop parent",
      });
      // A retry with the same key launches nothing new and records nothing new.
      const retried = yield* delegateToBox(a);
      expect(retried.taskId).toBe(delegated.taskId);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(1);

      yield* Ref.set(thread.reply, "All 412 tests pass on the box.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const task = yield* taskResult(a, delegated.taskId);
      expect(task).toMatchObject({ status: "completed", result: "All 412 tests pass on the box." });
      // The parent's live run claims the result, as for a child here.
      const parentRun = (yield* a.orchestrator.getThreadProjection(parentThreadId)).runs.find(
        (run) => run.id === parentRunId,
      );
      expect(parentRun?.delegatedCompletion?.delivery?.taskIds).toEqual([delegated.taskId]);
      expect((yield* Ref.get(offers)).map((offer) => offer.threadId)).toContain(parentThreadId);

      const status = yield* a.call("task_status", { taskId: delegated.taskId });
      expect(status.structuredContent).toMatchObject({
        status: "completed",
        summary: "All 412 tests pass on the box.",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task named only by environment inherits the parent's model, within the link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      // The parent runs with full access; the link allows less.
      yield* linkTo(a.links, b, "auto-accept-edits");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      // The parent's model, and the link's modes rather than the parent's.
      expect(yield* Ref.get(thread.launchedWith)).toEqual({
        modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
      });

      // Asking for more than the link allows is still refused there.
      const broader = yield* a.call("delegate_task", {
        task: "Run the suite on the box.",
        target: { environmentId: box.environmentId },
        runtimeMode: "full-access",
        clientRequestId: "broader",
      });
      expect(broader.isError).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("follows an open task again after the laptop restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // The laptop before the restart delegates, then goes away.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          return yield* delegateToBox(before);
        }),
      );
      // The task finishes on the box while the laptop is down.
      yield* Ref.set(thread.reply, "Finished while you were away.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);

      const after = yield* makeLaptop(database, offers);
      // The link lives in the laptop's own store, so it needs linking again here.
      yield* linkTo(after.links, b, "full-access");
      yield* after.remote.start();
      const task = yield* taskResult(after, delegated.taskId);
      expect(task).toMatchObject({ status: "completed", result: "Finished while you were away." });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("fails the task when the box revokes the link, and cancel interrupts it there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const cancelled = yield* delegateToBox(a);
      const cancel = yield* a.call("task_cancel", {
        taskId: cancelled.taskId,
        reason: "Not needed",
      });
      expect(cancel.structuredContent).toEqual({
        taskId: cancelled.taskId,
        status: "cancel_requested",
      });
      // Cancelling stops the thread there as Stop does: its queue and its own tasks too.
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
      expect(yield* taskResult(a, cancelled.taskId)).toMatchObject({ status: "cancelled" });

      // Cancelling again, once the result is in, still stops what came after it there.
      const again = yield* a.call("task_cancel", {
        taskId: cancelled.taskId,
        clientRequestId: "cancel-again",
      });
      expect(again.structuredContent).toEqual({ taskId: cancelled.taskId, status: "cancelled" });
      expect(yield* Ref.get(thread.interrupted)).toBe(2);
      // ...and a retry of that cancel stops nothing new.
      yield* a.call("task_cancel", { taskId: cancelled.taskId, clientRequestId: "cancel-again" });
      expect(yield* Ref.get(thread.interrupted)).toBe(2);

      // A second task, then the box revokes the link before it ends.
      const revoked = yield* a
        .call("delegate_task", {
          task: "Another one.",
          target: {
            environmentId: box.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
          },
          clientRequestId: "second",
        })
        .pipe(Effect.map((result) => result.structuredContent as { taskId: NodeId }));
      const [session] = yield* b.linkedSessions;
      yield* b.auth.revokeSession(session!.sessionId);
      yield* Deferred.succeed(thread.finished, undefined);
      const failed = yield* taskResult(a, revoked.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toBe(
        "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task's result is its own run's whole last reply, not a later run's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Review the diff.",
        role: "review",
        target: { environmentId: box.environmentId },
        clientRequestId: "review-on-box",
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      const { taskId } = result.structuredContent as { taskId: NodeId };
      // The role reaches the thread there, as it does a child here.
      expect(yield* Ref.get(thread.message)).toBe(
        "Act as the review sub-agent for this task.\n\nReview the diff.",
      );

      // A reply longer than one read, then a later run's reply on the same thread.
      const long = "x".repeat(45_000);
      yield* Ref.set(thread.reply, long);
      yield* Ref.set(thread.laterReply, "Someone else asked a follow-up.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const task = yield* taskResult(a, taskId);
      expect(task?.status).toBe("completed");
      expect(task?.result).toBe(long);
      // Every wait was for the run the launch started.
      const waits = yield* Ref.get(thread.waitedFor);
      expect(waits.length).toBeGreaterThan(0);
      expect(waits.every((runId) => runId === boxRunId)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the same key from another provider session is another task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const first = yield* delegateToBox(a);
      const later = yield* a.call(
        "delegate_task",
        {
          task: "Run the full suite on the box.",
          target: { environmentId: box.environmentId },
          clientRequestId: "suite-on-box",
        },
        { ...parentScope, requestNamespace: "provider-session:laptop-parent-2" },
      );
      expect(later.isError, JSON.stringify(later.content)).toBe(false);
      const second = later.structuredContent as {
        taskId: NodeId;
        remoteChild: { threadId: ThreadId };
      };
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.remoteChild.threadId).not.toBe(first.remoteChild.threadId);
      expect((yield* a.orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("fails the task when its thread there is gone, or the link here is", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      yield* Ref.set(thread.gone, true);
      const gone = yield* delegateToBox(a);
      const failed = yield* taskResult(a, gone.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toContain("was not found");

      // The link is forgotten here while the task runs there.
      yield* Ref.set(thread.gone, false);
      const forgotten = yield* a
        .call("delegate_task", {
          task: "Another one.",
          target: { environmentId: box.environmentId },
          clientRequestId: "forgotten",
        })
        .pipe(Effect.map((result) => result.structuredContent as { taskId: NodeId }));
      yield* a.links.unlink(box.environmentId);
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const unlinked = yield* taskResult(a, forgotten.taskId);
      expect(unlinked?.status).toBe("failed");
      expect(unlinked?.result).toContain("not linked to");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("cancel ends the task here even when the link is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      yield* a.links.unlink(box.environmentId);
      const cancel = yield* a.call("task_cancel", { taskId: delegated.taskId });
      expect(cancel.structuredContent).toEqual({
        taskId: delegated.taskId,
        status: "cancel_requested",
      });
      const task = yield* taskResult(a, delegated.taskId);
      expect(task?.status).toBe("cancelled");
      expect(task?.result).toContain("could not be stopped in Box");
      expect(yield* Ref.get(thread.interrupted)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a parent stopped while the task's result is read still stops its thread there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The task's run ends there, and while the follower reads its reply,
      // the parent here is stopped: more work may follow that run there.
      yield* Ref.set(thread.holdRead, true);
      yield* Ref.set(thread.reply, "Done there.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      yield* Deferred.await(thread.readStarted);
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-mid-read"),
      });
      yield* Deferred.succeed(thread.releaseRead, undefined);

      // The Stop's result stands, and the thread there is still stopped.
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.stops)).toContain("thread.stop");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a stop the box refuses because the parent was lowered ends instead of retrying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      // The parent is lowered below the full-access thread there, then stopped.
      yield* a.orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:lower:laptop-parent"),
        threadId: parentThreadId,
        runtimeMode: "approval-required",
      });
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-lowered"),
      });

      // The box refuses that stop; the follower records it as settled and
      // stops, so nothing retries it, now or after a restart.
      const settled = yield* a.orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.taskId &&
              stored.event.payload.remoteChild?.stoppedThere === true,
          ),
          Stream.runHead,
        );
      expect(Option.isSome(settled)).toBe(true);
      expect(yield* Ref.get(thread.stops)).toEqual([]);
      expect(yield* a.projections.getOpenRemoteDelegatedTasks).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("stopping the parent stops its task there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);

      const delegated = yield* delegateToBox(a);
      // What the delegated-tasks.stop effect runs once the parent's Stop commits.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent"),
        reason: "User stopped",
      });
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "interrupted",
        result: "Stopped with its parent: User stopped",
      });
      // The follower sees it ended here and stops it there.
      yield* Deferred.await(thread.interruptedOnce);
      expect(yield* Ref.get(thread.interrupted)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a parent stopped while the box is unreachable still stops its task there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // The box sleeps as soon as the task is there, so its follower backs off.
      const delegated = yield* delegateToBox(a);
      yield* Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const [link] = yield* a.links.list;
        if (link?.lastError !== null && link?.lastError !== undefined) break;
        yield* Effect.sleep(Duration.millis(20)).pipe(TestClock.withLive);
      }
      // The parent is stopped meanwhile.
      yield* a.threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("command:stop:laptop-parent-offline"),
      });
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({ status: "interrupted" });

      // Once the box is back, the follower's next attempt stops the task there.
      yield* Ref.set(b.descriptor, box);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (yield* Deferred.isDone(thread.interruptedOnce)) break;
        yield* TestClock.adjust(Duration.minutes(5));
        yield* Effect.sleep(Duration.millis(50)).pipe(TestClock.withLive);
      }
      expect(yield* Ref.get(thread.interrupted)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task cancelled while the box is unreachable is stopped there after a restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      // Its links outlive the restart, so the box knows it as the same link session.
      const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
      // The laptop cancels while the box sleeps, then restarts before it wakes.
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, linking);
          yield* linkTo(before.links, b, "full-access");
          yield* seedParent(before);
          const task = yield* delegateToBox(before);
          yield* Ref.set(b.descriptor, descriptorOf("environment-elsewhere", "Elsewhere"));
          yield* before.call("task_cancel", { taskId: task.taskId });
          expect(yield* taskResult(before, task.taskId)).toMatchObject({ status: "cancelled" });
          return task;
        }),
      );
      expect(yield* Ref.get(thread.interrupted)).toBe(0);

      yield* Ref.set(b.descriptor, box);
      const after = yield* makeLaptop(database, offers, linking);
      yield* after.remote.start();
      yield* Deferred.await(thread.interruptedOnce);
      // Once the stop is recorded, nothing is owed there any more.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const task = (yield* after.orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (candidate) => candidate.id === delegated.taskId,
        );
        if (task?.remoteChild?.stoppedThere === true) break;
        yield* Effect.sleep(Duration.millis(20)).pipe(TestClock.withLive);
      }
      expect(yield* after.projections.getOpenRemoteDelegatedTasks).toEqual([]);
      expect(yield* Ref.get(thread.stops)).toEqual(["thread.stop", "delegated-tasks"]);
      // The result here is still the cancel's.
      expect(yield* taskResult(after, delegated.taskId)).toMatchObject({ status: "cancelled" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task whose thread there has no run ends with its last reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* linkTo(a.links, b, "full-access");
      yield* seedParent(a);
      // As a task recorded before its run was kept, whose thread there is idle.
      yield* Ref.set(thread.runless, true);
      yield* Ref.set(thread.reply, "Done before it was followed.");

      const delegated = yield* delegateToBox(a);
      expect(yield* taskResult(a, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "Done before it was followed.",
      });
      // One look, not a loop.
      expect(yield* Ref.get(thread.waitedFor)).toEqual([undefined]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a local task runs in this thread's project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers);
      yield* seedParent(a);

      const result = yield* a.call("delegate_task", {
        task: "Run it here.",
        target: { projectId: "project:elsewhere" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("invalid_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
