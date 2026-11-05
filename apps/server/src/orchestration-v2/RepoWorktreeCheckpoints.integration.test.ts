import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as RepoWorktreeService from "../git/RepoWorktreeService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { SHARED_WORKSPACE_RESTORE_MESSAGE } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const agentInstanceId = ProviderInstanceId.make("codex");
const noRollbackInstanceId = ProviderInstanceId.make("codex-no-rollback");
const folderProjectId = ProjectId.make("project:repo-checkpoints:folder");
const alphaProjectId = ProjectId.make("project:repo-checkpoints:alpha");

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
}

interface Agent {
  readonly started: Queue.Queue<ActiveTurn>;
  readonly rollbacks: Ref.Ref<number>;
}

/** Starts a turn and hands it to the test, which plays the agent and then finishes it. */
function makeAgentAdapter(
  agent: Agent,
  instanceId: ProviderInstanceId,
  capabilities: OrchestrationV2ProviderCapabilities,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/unused",
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const providerTurnId = ProviderTurnId.make(`provider-turn:${turnInput.attemptId}`);
              const occurredAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: turnInput.providerTurnOrdinal,
                  status: "running",
                  startedAt: occurredAt,
                  completedAt: null,
                },
              });
              yield* Queue.offer(agent.started, { input: turnInput, providerTurnId, events });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: ({ providerThread }) =>
            Ref.update(agent.rollbacks, (count) => count + 1).pipe(
              Effect.as({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
            ),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const finishTurn = (active: ActiveTurn) =>
  Effect.gen(function* () {
    const occurredAt = yield* DateTime.now;
    yield* Queue.offer(active.events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: active.providerTurnId,
        providerThreadId: active.input.providerThread.id,
        nodeId: active.input.rootNodeId,
        runAttemptId: active.input.attemptId,
        nativeTurnRef: { driver, nativeId: `native:${active.providerTurnId}`, strength: "strong" },
        ordinal: active.input.providerTurnOrdinal,
        status: "completed",
        startedAt: occurredAt,
        completedAt: occurredAt,
      },
    });
    yield* Queue.offer(active.events, {
      type: "turn.terminal",
      driver,
      providerThreadId: active.input.providerThread.id,
      providerTurnId: active.providerTurnId,
      runOrdinal: active.input.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
  });

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-repo-checkpoints-config-",
}).pipe(Layer.provide(NodeServices.layer));
const layerGitDriver = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const gitDriver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* gitDriver.execute({
      operation: "RepoWorktreeCheckpoints.test",
      cwd,
      args,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const configureIdentity = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.email", "test@example.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  });

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "--initial-branch=main"]);
    yield* configureIdentity(cwd);
    // The same file in every repository, so diff paths must name the repository.
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), `# ${path.basename(cwd)}\n`);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
  });

const read = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).readFileString(file);
  });
const write = (file: string, contents: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(file, contents);
  });
const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file);
  });

interface Fixture {
  readonly root: string;
  readonly folder: string;
  readonly alpha: string;
  readonly beta: string;
  readonly server: string;
  readonly frameworkSource: string;
  readonly worktrees: string;
}

/** A plain folder (not a repository) holding repositories; `server` has a submodule. */
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-repo-checkpoints-" }),
  );
  const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "file";
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousAllowedProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
    }),
  );
  const fixture: Fixture = {
    root,
    folder: path.join(root, "folder"),
    alpha: path.join(root, "folder", "alpha"),
    beta: path.join(root, "folder", "beta"),
    server: path.join(root, "folder", "server"),
    frameworkSource: path.join(root, "framework-source"),
    worktrees: path.join(root, "worktrees"),
  };
  yield* initRepo(fixture.alpha);
  yield* initRepo(fixture.beta);
  yield* initRepo(fixture.frameworkSource);
  yield* initRepo(fixture.server);
  yield* git(fixture.server, ["submodule", "add", fixture.frameworkSource, "framework"]);
  yield* git(fixture.server, ["commit", "-m", "add framework"]);
  yield* configureIdentity(path.join(fixture.server, "framework"));
  return fixture;
});

const layerGitWorkflow = Layer.unwrap(
  Effect.gen(function* () {
    const gitDriver = yield* GitVcsDriver.GitVcsDriver;
    return Layer.mock(GitWorkflowService.GitWorkflowService)({
      remoteExists: gitDriver.remoteExists,
      fetchRemote: gitDriver.fetchRemote,
      resolveRemoteTrackingCommit: gitDriver.resolveRemoteTrackingCommit,
      pruneWorktrees: gitDriver.pruneWorktrees,
      createWorktree: (input, options) => gitDriver.createWorktree(input, options),
      removeWorktree: gitDriver.removeWorktree,
      deleteLocalBranch: gitDriver.deleteLocalBranch,
      invalidateStatus: () => Effect.void,
    });
  }),
);

function makeLayer(fixture: Fixture, agent: Agent) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "repo-worktree-checkpoints" },
    ProviderAdapterRegistry.layerFromAdapters([
      makeAgentAdapter(agent, agentInstanceId, CodexProviderCapabilitiesV2),
      makeAgentAdapter(agent, noRollbackInstanceId, {
        ...CodexProviderCapabilitiesV2,
        threads: { ...CodexProviderCapabilitiesV2.threads, canRollbackThread: false },
      }),
    ]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      // As in production: a thread without its own worktree works in the project folder.
      runtimePolicy: Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
        resolve: ({ thread }) =>
          Effect.succeed({
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            cwd:
              thread.worktreePath ??
              (thread.projectId === alphaProjectId ? fixture.alpha : fixture.folder),
          }),
      }),
      rollbackGitWorkflow: layerGitWorkflow.pipe(Layer.provide(layerGitDriver), Layer.orDie),
    },
  );
  const layerSettings = ServerSettings.layerTest({
    repoWorktrees: true,
    worktreesDirectory: fixture.worktrees,
    newWorktreesStartFromOrigin: false,
  });
  const layerThreads = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerCheckpointStore = CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer),
        Layer.provide(layerServerConfig),
      ),
    ),
  );
  return Layer.mergeAll(RepoWorktreeService.layer, CheckpointDiffQuery.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerThreads,
        layerSettings,
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: folderProjectId, workspaceRoot: fixture.folder } as never),
            ),
        }),
        layerGitWorkflow,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
        CheckpointService.layer.pipe(Layer.provide(IdAllocator.layer)),
        layerOrchestrator,
      ),
    ),
    Layer.provideMerge(layerCheckpointStore),
    Layer.provideMerge(layerGitDriver),
    Layer.provideMerge(layerServerConfig),
  );
}

let sequence = 0;
const createProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    sequence += 1;
    yield* projects.apply({
      sequence,
      eventId: EventId.make(`event:project:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-11-04T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-11-04T00:00:00.000Z",
        updatedAt: "2026-11-04T00:00:00.000Z",
      },
    });
  });

const createThread = (input: {
  readonly threadId: string;
  readonly projectId?: ProjectId;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly instanceId?: ProviderInstanceId;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(input.threadId);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: input.projectId ?? folderProjectId,
      title: input.threadId,
      modelSelection: { instanceId: input.instanceId ?? agentInstanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

let messageCounter = 0;
/** One turn: the agent's `work` runs while the turn is live, then the checkpoint is captured. */
const runTurn = <E, R>(agent: Agent, threadId: ThreadId, work: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    messageCounter += 1;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`message:${threadId}:${messageCounter}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${messageCounter}`),
      text: `turn ${messageCounter}`,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    const active = yield* Queue.take(agent.started);
    yield* work;
    const waiting = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === active.input.runId &&
        event.payload.status === "waiting",
    );
    yield* finishTurn(active);
    yield* Fiber.join(waiting);
    yield* worker.drain();
    return active.input.runOrdinal;
  });

const projectionOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    return yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
  });

const rollbackCommand = (threadId: ThreadId, turnCount: number, restoreFiles: boolean) =>
  Effect.gen(function* () {
    const projection = yield* projectionOf(threadId);
    const checkpoint = projection.checkpoints.findLast((candidate) =>
      turnCount === 0
        ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
        : candidate.appRunOrdinal === turnCount,
    );
    if (checkpoint === undefined) return yield* Effect.die(`no checkpoint for turn ${turnCount}`);
    messageCounter += 1;
    return {
      type: "checkpoint.rollback" as const,
      commandId: CommandId.make(`rollback:${threadId}:${messageCounter}`),
      threadId,
      scopeId: checkpoint.scopeId,
      checkpointId: checkpoint.id,
      restoreFiles,
    };
  });

const rollback = (threadId: ThreadId, turnCount: number, restoreFiles = true) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch(yield* rollbackCommand(threadId, turnCount, restoreFiles));
    yield* worker.drain();
    return yield* projectionOf(threadId);
  });

const withHarness = <A, E, R>(
  test: (input: { readonly fixture: Fixture; readonly agent: Agent }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture.pipe(Effect.provide(layerGitDriver));
    const agent: Agent = {
      started: yield* Queue.unbounded<ActiveTurn>(),
      rollbacks: yield* Ref.make(0),
    };
    return yield* Effect.gen(function* () {
      yield* createProject(folderProjectId, fixture.folder);
      return yield* test({ fixture, agent });
    }).pipe(Effect.provide(makeLayer(fixture, agent)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("repository worktree checkpoints", () => {
  it.effect(
    "captures, diffs, and restores two repositories of a folder that is not a Git repository",
    () =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          const threadId = yield* createThread({ threadId: "thread:folder" });

          // Someone already works in a beta worktree; its edits predate the thread.
          const betaWorktree = path.join(fixture.worktrees, "beta", "shared");
          yield* git(fixture.beta, ["worktree", "add", "-b", "shared", betaWorktree]);
          yield* write(path.join(betaWorktree, "README.md"), "# beta\nearlier edit\n");
          yield* write(path.join(betaWorktree, "notes.txt"), "earlier untracked\n");

          let alphaWorktree = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              const alpha = yield* repoWorktrees.ensure({
                threadId,
                repository: "alpha",
                branch: "t3/work",
                baseRef: "main",
              });
              alphaWorktree = alpha.repoWorktree.worktreePath;
              yield* write(path.join(alphaWorktree, "README.md"), "# alpha\nturn 1\n");
              yield* write(path.join(alphaWorktree, "new.txt"), "untracked in turn 1\n");
              // Found partway through the turn.
              const beta = yield* repoWorktrees.ensure({
                threadId,
                repository: "beta",
                branch: "shared",
              });
              assert.equal(beta.status, "reused");
              assert.equal(beta.uncommittedFiles, 2);
              yield* write(path.join(betaWorktree, "README.md"), "# beta\nearlier edit\nturn 1\n");
            }),
          );

          const afterFirst = yield* projectionOf(threadId);
          assert.deepEqual(
            afterFirst.checkpointScopes.map((scope) => scope.cwd),
            [fixture.folder],
          );
          const first = afterFirst.checkpoints.find(
            (checkpoint) => checkpoint.appRunOrdinal === 1,
          )!;
          assert.equal(first.status, "ready");
          assert.equal(first.workspaceStatus, "missing");
          assert.deepEqual(
            first.repositories?.map((entry) => [entry.pathPrefix, entry.status]),
            [
              ["alpha", "ready"],
              ["beta", "ready"],
            ],
          );
          assert.sameMembers(
            first.files.map((file) => file.path),
            ["alpha/README.md", "alpha/new.txt", "beta/README.md"],
          );
          // The thread start is a rollback target too, from the baselines taken on attach.
          const threadStart = afterFirst.checkpoints.find(
            (checkpoint) => checkpoint.ordinalWithinScope === 0,
          )!;
          assert.equal(threadStart.status, "ready");

          const firstDiff = yield* diffs.getFullThreadDiff({ threadId, toTurnCount: 1 });
          assert.include(firstDiff.diff, "diff --git a/alpha/README.md b/alpha/README.md");
          assert.include(firstDiff.diff, "diff --git a/beta/README.md b/beta/README.md");
          assert.include(firstDiff.diff, "+turn 1");
          // Edits that predate the thread are its baseline, not its work.
          assert.notInclude(firstDiff.diff, "+earlier edit");
          assert.notInclude(firstDiff.diff, "notes.txt");

          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              yield* git(alphaWorktree, ["add", "."]);
              yield* git(alphaWorktree, ["commit", "-m", "turn 1 work"]);
              yield* write(path.join(alphaWorktree, "README.md"), "# alpha\nturn 2\n");
            }),
          );
          const secondDiff = yield* diffs.getTurnDiff({
            threadId,
            fromTurnCount: 1,
            toTurnCount: 2,
          });
          assert.include(secondDiff.diff, "diff --git a/alpha/README.md b/alpha/README.md");
          assert.include(secondDiff.diff, "+turn 2");
          assert.notInclude(secondDiff.diff, "beta/");

          // Rewind turn 2: alpha gets turn 1's files back; its commit stays.
          const rewound = yield* rollback(threadId, 1);
          assert.equal(yield* read(path.join(alphaWorktree, "README.md")), "# alpha\nturn 1\n");
          assert.equal(yield* git(alphaWorktree, ["log", "-1", "--format=%s"]), "turn 1 work");
          assert.equal(rewound.runs.find((run) => run.ordinal === 2)?.status, "rolled_back");
          assert.equal(
            rewound.checkpoints.find((checkpoint) => checkpoint.appRunOrdinal === 2)?.status,
            "stale",
          );

          // A turn after the rewind diffs against the restored files.
          yield* runTurn(
            agent,
            threadId,
            write(path.join(alphaWorktree, "README.md"), "# alpha\nturn 1\nturn 3\n"),
          );
          const thirdDiff = yield* diffs.getTurnDiff({
            threadId,
            fromTurnCount: 2,
            toTurnCount: 3,
          });
          assert.include(thirdDiff.diff, "+turn 3");
          assert.notInclude(thirdDiff.diff, "-turn 2");

          // Back to the start: both worktrees as the thread found them.
          yield* rollback(threadId, 0);
          assert.equal(yield* read(path.join(alphaWorktree, "README.md")), "# alpha\n");
          assert.isFalse(yield* exists(path.join(alphaWorktree, "new.txt")));
          assert.equal(yield* read(path.join(betaWorktree, "README.md")), "# beta\nearlier edit\n");
          assert.equal(yield* read(path.join(betaWorktree, "notes.txt")), "earlier untracked\n");
          assert.isTrue(yield* exists(betaWorktree));
          // The source checkouts never change.
          assert.equal(yield* read(path.join(fixture.alpha, "README.md")), "# alpha\n");
          assert.equal(yield* git(fixture.alpha, ["branch", "--show-current"]), "main");
          assert.equal(yield* git(fixture.beta, ["status", "--porcelain"]), "");
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 2);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    "restores a parent worktree's gitlink and submodule checkout with its framework worktree",
    () =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const threadId = yield* createThread({ threadId: "thread:framework" });
          const sourceFrameworkHead = yield* git(path.join(fixture.server, "framework"), [
            "rev-parse",
            "HEAD",
          ]);
          const sourceServerHead = yield* git(fixture.server, ["rev-parse", "HEAD"]);
          const sourceOrigin = yield* git(path.join(fixture.server, "framework"), [
            "config",
            "--get",
            "remote.origin.url",
          ]);
          let parent = "";
          let framework = "";
          const commitFramework = (contents: string) =>
            Effect.gen(function* () {
              yield* write(path.join(framework, "README.md"), contents);
              yield* git(framework, ["commit", "-am", contents.trim()]);
              const pinned = yield* repoWorktrees.setSubmoduleCommit({
                threadId,
                worktreePath: parent,
                submodulePath: "framework",
                sourceWorktreePath: framework,
              });
              yield* git(parent, ["commit", "-m", `pin ${contents.trim()}`]);
              return pinned.commit;
            });

          let firstPin = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              framework = (yield* repoWorktrees.ensure({
                threadId,
                repository: "server/framework",
                branch: "t3/framework",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              parent = (yield* repoWorktrees.ensure({
                threadId,
                repository: "server",
                branch: "t3/framework",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              yield* configureIdentity(framework);
              yield* configureIdentity(parent);
              firstPin = yield* commitFramework("framework one\n");
            }),
          );
          let secondPin = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              secondPin = yield* commitFramework("framework two\n");
            }),
          );
          const embedded = path.join(parent, "framework");
          assert.equal(yield* git(embedded, ["rev-parse", "HEAD"]), secondPin);

          yield* rollback(threadId, 1);
          assert.equal(yield* read(path.join(framework, "README.md")), "framework one\n");
          assert.equal(yield* git(embedded, ["rev-parse", "HEAD"]), firstPin);
          assert.equal(
            yield* git(parent, ["ls-files", "--stage", "--", "framework"]).pipe(
              Effect.map((line) => line.split(" ")[1]),
            ),
            secondPin,
            "the index keeps HEAD's gitlink, as files restore without touching history",
          );
          assert.equal(
            yield* git(parent, ["ls-tree", "HEAD~1", "framework"]).pipe(
              Effect.map((line) => line.split(/\s+/)[2]),
            ),
            firstPin,
          );
          // The source checkouts and their origins are untouched.
          assert.equal(
            yield* git(path.join(fixture.server, "framework"), ["rev-parse", "HEAD"]),
            sourceFrameworkHead,
          );
          assert.equal(yield* git(fixture.server, ["rev-parse", "HEAD"]), sourceServerHead);
          assert.equal(
            yield* git(path.join(fixture.server, "framework"), [
              "config",
              "--get",
              "remote.origin.url",
            ]),
            sourceOrigin,
          );
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    "restores a worktree first attached after the target, and one detached since",
    () =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const threadId = yield* createThread({ threadId: "thread:late" });
          let alpha = "";
          let beta = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              alpha = (yield* repoWorktrees.ensure({
                threadId,
                repository: "alpha",
                branch: "t3/late",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\n");
            }),
          );
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              beta = (yield* repoWorktrees.ensure({
                threadId,
                repository: "beta",
                branch: "t3/late",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              yield* write(path.join(beta, "README.md"), "# beta\nturn 2\n");
              yield* write(path.join(alpha, "README.md"), "# alpha\nturn 2\n");
            }),
          );
          // The worktree is let go and the feature turned off; the history still restores it.
          yield* repoWorktrees.detach({ threadId, worktreePath: beta });
          yield* settings.updateSettings({ repoWorktrees: false });

          const rewound = yield* rollback(threadId, 1);
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 1\n");
          assert.equal(yield* read(path.join(beta, "README.md")), "# beta\n");
          assert.isNull(rewound.thread.rollbackFailure ?? null);
          assert.equal(yield* read(path.join(fixture.beta, "README.md")), "# beta\n");
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    "refuses file restore of a checkout another thread works in, both ways",
    () =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          yield* createProject(alphaProjectId, fixture.alpha);
          // An ordinary thread's own worktree, reached through a link.
          const worktree = path.join(fixture.worktrees, "alpha", "ordinary");
          yield* git(fixture.alpha, ["worktree", "add", "-b", "t3/ordinary", worktree]);
          const alias = path.join(fixture.root, "alias");
          yield* fileSystem.symlink(fixture.worktrees, alias);
          const ordinary = yield* createThread({
            threadId: "thread:ordinary",
            projectId: alphaProjectId,
            worktreePath: path.join(alias, "alpha", "ordinary"),
            branch: "t3/ordinary",
          });
          yield* runTurn(
            agent,
            ordinary,
            write(path.join(worktree, "README.md"), "# alpha\nordinary\n"),
          );

          const folder = yield* createThread({ threadId: "thread:folder-reuse" });
          yield* runTurn(
            agent,
            folder,
            Effect.gen(function* () {
              const reused = yield* repoWorktrees.ensure({
                threadId: folder,
                repository: "alpha",
                branch: "t3/ordinary",
              });
              assert.equal(reused.repoWorktree.worktreePath, worktree);
              yield* write(path.join(worktree, "README.md"), "# alpha\nordinary\nfolder\n");
            }),
          );
          const otherFolder = yield* createThread({ threadId: "thread:folder-second" });
          yield* repoWorktrees.ensure({
            threadId: otherFolder,
            repository: "alpha",
            branch: "t3/ordinary",
          });

          const before = yield* read(path.join(worktree, "README.md"));
          for (const threadId of [ordinary, folder]) {
            const error = yield* orchestrator
              .dispatch(yield* rollbackCommand(threadId, 0, true))
              .pipe(Effect.flip);
            assert.equal(error._tag, "OrchestratorDispatchError");
            assert.include(
              error._tag === "OrchestratorDispatchError" ? String(error.cause) : "",
              threadId === ordinary
                ? SHARED_WORKSPACE_RESTORE_MESSAGE
                : "Another thread also works in the alpha worktree",
            );
          }
          assert.equal(yield* read(path.join(worktree, "README.md")), before);
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 0);

          // Reading stays open: diffs, and rewinding the conversation alone.
          const folderDiff = yield* diffs.getFullThreadDiff({ threadId: folder, toTurnCount: 1 });
          assert.include(folderDiff.diff, "diff --git a/alpha/README.md b/alpha/README.md");
          yield* rollback(folder, 0, false);
          assert.equal(yield* read(path.join(worktree, "README.md")), before);
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 1);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    "changes nothing when one repository cannot be restored",
    () =>
      withHarness(({ agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* createThread({ threadId: "thread:failure" });
          let alpha = "";
          let beta = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              alpha = (yield* repoWorktrees.ensure({
                threadId,
                repository: "alpha",
                branch: "t3/failure",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              beta = (yield* repoWorktrees.ensure({
                threadId,
                repository: "beta",
                branch: "t3/failure",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\n");
              yield* write(path.join(beta, "README.md"), "# beta\nturn 1\n");
            }),
          );
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              yield* write(path.join(alpha, "README.md"), "# alpha\nturn 2\n");
              yield* write(path.join(beta, "README.md"), "# beta\nturn 2\n");
            }),
          );
          // Beta's snapshot for turn 1 is gone.
          const projection = yield* projectionOf(threadId);
          const betaRef = projection.checkpoints
            .find((checkpoint) => checkpoint.appRunOrdinal === 1)
            ?.repositories?.find((entry) => entry.repository === "beta")?.ref;
          yield* git(beta, ["update-ref", "-d", betaRef!]);

          yield* rollback(threadId, 1);
          for (let attempt = 0; attempt < 5; attempt += 1) {
            yield* TestClock.adjust(Duration.seconds(31));
            yield* worker.drain();
          }
          const after = yield* projectionOf(threadId);
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 2\n");
          assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nturn 2\n");
          assert.equal(after.runs.find((run) => run.ordinal === 2)?.status, "completed");
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 0);
          assert.include(after.thread.rollbackFailure?.message ?? "", "No checkpoint of beta");
          assert.include(after.thread.rollbackFailure?.message ?? "", "Nothing was changed");
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect.each(["removed", "replaced"] as const)(
    "handles a repository worktree whose folder is %s",
    (state) =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* createThread({ threadId: `thread:${state}` });
          let alpha = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              alpha = (yield* repoWorktrees.ensure({
                threadId,
                repository: "alpha",
                branch: "t3/missing",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\n");
            }),
          );
          yield* runTurn(
            agent,
            threadId,
            write(path.join(alpha, "README.md"), "# alpha\nturn 2\n"),
          );
          yield* fileSystem.remove(alpha, { recursive: true });
          if (state === "replaced") {
            yield* fileSystem.makeDirectory(alpha);
            yield* write(path.join(alpha, "unrelated.txt"), "someone else's folder\n");
          }

          const after = yield* rollback(threadId, 1);
          if (state === "removed") {
            // Recreated from its branch, like a thread's own removed worktree.
            assert.equal(yield* git(alpha, ["branch", "--show-current"]), "t3/missing");
            assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 1\n");
            assert.equal(after.runs.find((run) => run.ordinal === 2)?.status, "rolled_back");
            return;
          }
          for (let attempt = 0; attempt < 5; attempt += 1) {
            yield* TestClock.adjust(Duration.seconds(31));
            yield* worker.drain();
          }
          const refused = yield* projectionOf(threadId);
          assert.equal(yield* read(path.join(alpha, "unrelated.txt")), "someone else's folder\n");
          assert.isFalse(yield* exists(path.join(alpha, "README.md")));
          assert.include(
            refused.thread.rollbackFailure?.message ?? "",
            "is no longer a worktree of alpha",
          );
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 0);
          assert.equal(yield* read(path.join(fixture.alpha, "README.md")), "# alpha\n");
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    "rejects rollback for a provider that cannot rewind before any file changes",
    () =>
      withHarness(({ agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
          const threadId = yield* createThread({
            threadId: "thread:no-rollback",
            instanceId: noRollbackInstanceId,
          });
          let alpha = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              alpha = (yield* repoWorktrees.ensure({
                threadId,
                repository: "alpha",
                branch: "t3/no-rollback",
                baseRef: "main",
              })).repoWorktree.worktreePath;
              yield* write(path.join(alpha, "README.md"), "# alpha\nkept\n");
            }),
          );
          const error = yield* orchestrator
            .dispatch(yield* rollbackCommand(threadId, 0, true))
            .pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.include(
            error._tag === "OrchestratorDispatchError" ? String(error.cause) : "",
            "rollback",
          );
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nkept\n");
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 0);
        }),
      ),
    { timeout: 120_000 },
  );
});
