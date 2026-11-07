import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
import { revertCodexThreadAfter } from "../provider/CodexThreadRevert.ts";
import {
  CodexProviderCapabilitiesV2,
  resolveCodexRollbackBoundary,
} from "./Adapters/CodexAdapterV2.ts";
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
const serverProjectId = ProjectId.make("project:repo-checkpoints:server");

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
}

interface Agent {
  readonly started: Queue.Queue<ActiveTurn>;
  readonly rollbacks: Ref.Ref<number>;
  /** The provider's own turn history, oldest first, which a rewind really truncates. */
  readonly nativeTurns: Ref.Ref<ReadonlyArray<string>>;
  /** Drops the reply to the next revert after it lands, as a lost connection would. */
  readonly loseNextRevertReply: Ref.Ref<boolean>;
}

/** Answers Codex's history requests from `agent.nativeTurns`. */
const codexHistory = (agent: Agent) => ({
  request: ((
    method: string,
    params: {
      readonly threadId: string;
      readonly cursor?: string | null;
      readonly limit?: number;
      readonly beforeTurnId?: string;
    },
  ) =>
    Effect.gen(function* () {
      const turns = yield* Ref.get(agent.nativeTurns);
      if (method === "thread/turns/list") {
        const newestFirst = turns.toReversed();
        const start = Number(params.cursor ?? 0);
        const end = start + (params.limit ?? 100);
        return {
          data: newestFirst.slice(start, end).map((id) => ({ id, items: [], status: "completed" })),
          nextCursor: end < newestFirst.length ? String(end) : null,
        };
      }
      if (method === "thread/revert") {
        const index = turns.indexOf(params.beforeTurnId ?? "");
        const reply = (message: string) =>
          CodexErrors.CodexAppServerRequestError.internalError(message, undefined, {
            method: "thread/revert",
            operation: "decode-payload",
          });
        if (index < 0) return yield* reply(`Unknown turn ${params.beforeTurnId}.`);
        yield* Ref.set(agent.nativeTurns, turns.slice(0, index));
        if (yield* Ref.getAndSet(agent.loseNextRevertReply, false)) {
          return yield* reply("The connection closed before Codex replied.");
        }
      }
      return { thread: { id: params.threadId } };
    })) as unknown as CodexClient.CodexAppServerClient["Service"]["request"],
});

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
              yield* Ref.update(agent.nativeTurns, (turns) => [
                ...turns,
                `native:${providerTurnId}`,
              ]);
              yield* Queue.offer(agent.started, { input: turnInput, providerTurnId, events });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          // Codex's own rewind, against history that a revert really changes.
          rollbackThread: (rollbackInput) =>
            Effect.gen(function* () {
              yield* Ref.update(agent.rollbacks, (count) => count + 1);
              const boundary = yield* resolveCodexRollbackBoundary(rollbackInput);
              if (boundary.laterTurnIds.size > 0) {
                yield* revertCodexThreadAfter(codexHistory(agent), "native", boundary).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterRollbackThreadError({
                        driver,
                        providerThreadId: rollbackInput.providerThread.id,
                        cause,
                      }),
                  ),
                );
              }
              return {
                providerThread: rollbackInput.providerThread,
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
              };
            }),
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
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
            Effect.succeedSome({ id: folderProjectId, workspaceRoot: fixture.folder } as never),
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
      nativeTurns: yield* Ref.make<ReadonlyArray<string>>([]),
      loseNextRevertReply: yield* Ref.make(false),
    };
    return yield* Effect.gen(function* () {
      yield* createProject(folderProjectId, fixture.folder);
      return yield* test({ fixture, agent });
    }).pipe(Effect.provide(makeLayer(fixture, agent)));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

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
              yield* write(path.join(framework, "local.env"), "tracked in turn 1\n");
              yield* git(framework, ["add", "local.env"]);
              firstPin = yield* commitFramework("framework one\n");
            }),
          );
          let secondPin = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              yield* git(framework, ["rm", "--quiet", "local.env"]);
              yield* write(path.join(framework, ".gitignore"), "local.env\n");
              yield* git(framework, ["add", ".gitignore"]);
              secondPin = yield* commitFramework("framework two\n");
            }),
          );
          const embedded = path.join(parent, "framework");
          assert.equal(yield* git(embedded, ["rev-parse", "HEAD"]), secondPin);

          // Turn 1's commit tracks the file this ignored one sits at, so nothing moves.
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const localFile = path.join(embedded, "local.env");
          yield* write(localFile, "my settings\n");
          yield* rollback(threadId, 1);
          for (let attempt = 0; attempt < 5; attempt += 1) {
            yield* TestClock.adjust(Duration.seconds(31));
            yield* worker.drain();
          }
          const refused = yield* projectionOf(threadId);
          assert.include(
            refused.thread.rollbackFailure?.message ?? "",
            "The submodule framework in server at",
          );
          assert.include(refused.thread.rollbackFailure?.message ?? "", "untracked or ignored");
          assert.equal(refused.runs.find((run) => run.ordinal === 2)?.status, "completed");
          assert.equal(yield* agent.rollbacks.pipe(Ref.get), 0);
          assert.equal(yield* read(localFile), "my settings\n");
          assert.equal(yield* git(embedded, ["rev-parse", "HEAD"]), secondPin);
          assert.equal(yield* read(path.join(framework, "README.md")), "framework two\n");
          yield* (yield* FileSystem.FileSystem).remove(localFile);

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
  );

  it.effect("moves the submodule of a thread's own checkout back with its files", () =>
    withHarness(({ fixture, agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
        yield* createProject(serverProjectId, fixture.server);
        const own = path.join(fixture.worktrees, "server", "own");
        yield* git(fixture.server, ["worktree", "add", "-b", "t3/own", own]);
        yield* git(own, ["submodule", "update", "--init", "--quiet"]);
        yield* configureIdentity(own);
        const threadId = yield* createThread({
          threadId: "thread:own-checkout",
          projectId: serverProjectId,
          worktreePath: own,
          branch: "t3/own",
        });
        let framework = "";
        const pin = (contents: string) =>
          Effect.gen(function* () {
            yield* write(path.join(framework, "README.md"), contents);
            yield* git(framework, ["commit", "-am", contents.trim()]);
            return (yield* repoWorktrees.setSubmoduleCommit({
              threadId,
              worktreePath: own,
              submodulePath: "framework",
              sourceWorktreePath: framework,
            })).commit;
          });

        let firstPin = "";
        yield* runTurn(
          agent,
          threadId,
          Effect.gen(function* () {
            // Pinning into its own checkout needs it attached.
            const attached = yield* repoWorktrees.ensure({
              threadId,
              repository: "server",
              branch: "t3/own",
            });
            assert.equal(attached.repoWorktree.worktreePath, own);
            framework = (yield* repoWorktrees.ensure({
              threadId,
              repository: "server/framework",
              branch: "t3/framework",
              baseRef: "main",
            })).repoWorktree.worktreePath;
            yield* configureIdentity(framework);
            firstPin = yield* pin("framework one\n");
          }),
        );
        yield* runTurn(agent, threadId, Effect.asVoid(pin("framework two\n")));

        const rewound = yield* rollback(threadId, 1);
        assert.isNull(rewound.thread.rollbackFailure ?? null);
        assert.equal(yield* git(path.join(own, "framework"), ["rev-parse", "HEAD"]), firstPin);
      }),
    ),
  );

  it.effect("restores a worktree first attached after the target, and one detached since", () =>
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
  );

  it.effect("names a detached worktree and a later one of its repository apart", () =>
    withHarness(({ agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
        const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const threadId = yield* createThread({ threadId: "thread:history-prefix" });
        const work = (branch: string, contents: string) =>
          Effect.gen(function* () {
            const worktree = (yield* repoWorktrees.ensure({
              threadId,
              repository: "alpha",
              branch,
              baseRef: "main",
            })).repoWorktree.worktreePath;
            yield* write(path.join(worktree, "README.md"), contents);
            return worktree;
          });
        let first = "";
        yield* runTurn(
          agent,
          threadId,
          Effect.map(work("t3/history-one", "# alpha\nfirst worktree\n"), (worktree) => {
            first = worktree;
          }),
        );
        yield* repoWorktrees.detach({ threadId, worktreePath: first });
        let second = "";
        yield* runTurn(
          agent,
          threadId,
          Effect.map(work("t3/history-two", "# alpha\nsecond worktree\n"), (worktree) => {
            second = worktree;
          }),
        );

        const prefixes = (yield* projectionOf(threadId)).checkpoints
          .filter((checkpoint) => checkpoint.appRunOrdinal !== null)
          .flatMap((checkpoint) => checkpoint.repositories ?? [])
          .map((entry) => [entry.worktreePath, entry.pathPrefix]);
        const secondPrefix = `alpha@${path.basename(second)}`;
        assert.deepEqual(prefixes, [
          [first, "alpha"],
          [second, secondPrefix],
        ]);
        const full = yield* diffs.getFullThreadDiff({ threadId, toTurnCount: 2 });
        assert.include(full.diff, "diff --git a/alpha/README.md b/alpha/README.md");
        assert.include(
          full.diff,
          `diff --git a/${secondPrefix}/README.md b/${secondPrefix}/README.md`,
        );
        assert.include(full.diff, "+first worktree");
        assert.include(full.diff, "+second worktree");
      }),
    ),
  );

  it.effect("refuses file restore of a checkout another thread works in, both ways", () =>
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
  );

  it.effect("changes nothing when one repository cannot be restored", () =>
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
  );

  // Permissions do not stop root or Windows from writing.
  const permissionsBlockWrites =
    HostProcess.Platform.defaultValue() !== "win32" && HostProcess.UserId.defaultValue() !== 0;
  const failsPartway = (finish: "rollback" | "outbox") =>
    withHarness(({ fixture, agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        yield* initRepo(path.join(fixture.folder, "gamma"));
        const threadId = yield* createThread({ threadId: "thread:partial" });
        const ensure = (repository: string) =>
          Effect.map(
            repoWorktrees.ensure({ threadId, repository, branch: "t3/partial", baseRef: "main" }),
            (result) => result.repoWorktree.worktreePath,
          );
        let alpha = "";
        let beta = "";
        let gamma = "";
        yield* runTurn(agent, threadId, Effect.void);
        yield* runTurn(
          agent,
          threadId,
          Effect.gen(function* () {
            alpha = yield* ensure("alpha");
            beta = yield* ensure("beta");
            yield* write(path.join(alpha, "README.md"), "# alpha\nturn 2\n");
            yield* write(path.join(beta, "README.md"), "# beta\nturn 2\n");
          }),
        );
        yield* runTurn(
          agent,
          threadId,
          Effect.gen(function* () {
            yield* write(path.join(alpha, "README.md"), "# alpha\nturn 3\n");
            yield* git(alpha, ["commit", "-am", "turn 3 work"]);
            yield* write(path.join(beta, "README.md"), "# beta\nturn 3\n");
            // First used in the turn being rewound, so its baseline is the target.
            gamma = yield* ensure("gamma");
            yield* write(path.join(gamma, "README.md"), "# gamma\nturn 3\n");
          }),
        );
        const committed = yield* git(alpha, ["rev-parse", "HEAD"]);
        const nativeTurns = yield* Ref.get(agent.nativeTurns);
        assert.equal(nativeTurns.length, 3);
        const retained = nativeTurns.slice(0, 2);

        // Git can read beta but not replace its files.
        yield* fileSystem.chmod(beta, 0o555);
        yield* Effect.addFinalizer(() => fileSystem.chmod(beta, 0o755).pipe(Effect.ignore));

        const partial = yield* rollback(threadId, 2);
        // Codex and the thread both went back to turn 2, in one step.
        assert.deepEqual(yield* Ref.get(agent.nativeTurns), retained);
        assert.deepEqual(
          partial.runs.map((run) => run.status),
          ["completed", "completed", "rolled_back"],
        );
        const message = partial.thread.rollbackFailure?.message ?? "";
        assert.include(
          message,
          "The conversation was rewound, but restoring files stopped at the beta worktree",
        );
        assert.include(message, "Already restored: alpha.");
        // Not finished: turn 3's checkpoint still holds what the retry restores.
        assert.equal(
          partial.checkpoints.find((checkpoint) => checkpoint.appRunOrdinal === 3)?.status,
          "ready",
        );
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 2\n");
        assert.equal(yield* git(alpha, ["rev-parse", "HEAD"]), committed);
        assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nturn 3\n");

        if (finish === "outbox") {
          // Fixed before the outbox's next attempt, which finishes the files.
          yield* fileSystem.chmod(beta, 0o755);
          yield* TestClock.adjust(Duration.seconds(31));
          yield* worker.drain();
        } else {
          // The outbox's remaining attempts find nothing left to rewind.
          for (let attempt = 0; attempt < 4; attempt += 1) {
            yield* TestClock.adjust(Duration.seconds(31));
            yield* worker.drain();
          }
          assert.equal(yield* Ref.get(agent.rollbacks), 1);
          assert.deepEqual(yield* Ref.get(agent.nativeTurns), retained);
          assert.equal((yield* projectionOf(threadId)).thread.rollbackFailure?.message, message);

          // The rewound turn's checkpoint is not a target while its files wait.
          const refused = yield* orchestrator
            .dispatch(yield* rollbackCommand(threadId, 3, true))
            .pipe(Effect.flip);
          assert.include(
            refused._tag === "OrchestratorDispatchError" ? String(refused.cause) : "",
            "already rolled back",
          );

          // Fixed, the same rollback finishes the files.
          yield* fileSystem.chmod(beta, 0o755);
          yield* rollback(threadId, 2);
        }
        // Codex was asked once, and kept its first two turns.
        const finished = yield* projectionOf(threadId);
        assert.equal(yield* Ref.get(agent.rollbacks), 1);
        assert.deepEqual(yield* Ref.get(agent.nativeTurns), retained);
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 2\n");
        assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nturn 2\n");
        assert.equal(yield* read(path.join(gamma, "README.md")), "# gamma\n");
        assert.equal(
          finished.checkpoints.find((checkpoint) => checkpoint.appRunOrdinal === 3)?.status,
          "stale",
        );
        assert.isNull(finished.thread.rollbackFailure ?? null);

        // The thread goes on from turn 2.
        yield* runTurn(
          agent,
          threadId,
          write(path.join(alpha, "README.md"), "# alpha\nturn 2\nturn 4\n"),
        );
        const continued = yield* Ref.get(agent.nativeTurns);
        assert.deepEqual(continued.slice(0, 2), retained);
        assert.equal(continued.length, 3);
        const fourth = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 3, toTurnCount: 4 });
        assert.include(fourth.diff, "+turn 4");
        assert.notInclude(fourth.diff, "beta/");
        assert.notInclude(fourth.diff, "gamma/");
      }),
    );
  it.effect.skipIf(!permissionsBlockWrites)(
    "keeps the retained turns when restoring files fails partway, then finishes on a later rollback",
    () => failsPartway("rollback"),
  );
  it.effect.skipIf(!permissionsBlockWrites)(
    "finishes restoring files on the outbox's next attempt once the worktree is fixed",
    () => failsPartway("outbox"),
  );

  /**
   * Turn 1 attaches nothing, turn 2 attaches alpha, and turn 3 first attaches
   * beta, a reused worktree with edits of its own. Rewinding to turn 2 then
   * sends beta back to how the thread found it.
   */
  const attachedInRewoundTurn = (fixture: Fixture, agent: Agent, name: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
      const threadId = yield* createThread({ threadId: `thread:${name}` });
      const beta = path.join(fixture.worktrees, "beta", "shared");
      yield* git(fixture.beta, ["worktree", "add", "-b", "shared", beta]);
      yield* write(path.join(beta, "README.md"), "# beta\nearlier edit\n");
      yield* write(path.join(beta, "notes.txt"), "earlier untracked\n");
      let alpha = "";
      yield* runTurn(agent, threadId, Effect.void);
      yield* runTurn(
        agent,
        threadId,
        Effect.gen(function* () {
          alpha = (yield* repoWorktrees.ensure({
            threadId,
            repository: "alpha",
            branch: `t3/${name}`,
            baseRef: "main",
          })).repoWorktree.worktreePath;
          yield* write(path.join(alpha, "README.md"), "# alpha\nturn 2\n");
        }),
      );
      yield* runTurn(
        agent,
        threadId,
        Effect.gen(function* () {
          const reused = yield* repoWorktrees.ensure({
            threadId,
            repository: "beta",
            branch: "shared",
          });
          assert.equal(reused.status, "reused");
          yield* write(path.join(beta, "README.md"), "# beta\nearlier edit\nturn 3\n");
          yield* write(path.join(beta, "draft.txt"), "turn 3\n");
        }),
      );
      const turnThreeRef = (yield* projectionOf(threadId)).checkpoints
        .find((checkpoint) => checkpoint.appRunOrdinal === 3)
        ?.repositories?.find((entry) => entry.repository === "beta")?.ref;
      assert.isDefined(turnThreeRef);
      const turnThree = {
        ref: turnThreeRef!,
        commit: yield* git(beta, ["rev-parse", turnThreeRef!]),
      };

      const rewound = yield* rollback(threadId, 2);
      assert.isNull(rewound.thread.rollbackFailure ?? null);
      assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 2\n");
      yield* expectBetaBaseline(beta);
      return { threadId, alpha, beta, turnThree };
    });
  const expectBetaBaseline = (beta: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nearlier edit\n");
      assert.equal(yield* read(path.join(beta, "notes.txt")), "earlier untracked\n");
      assert.isFalse(yield* exists(path.join(beta, "draft.txt")));
      assert.equal(yield* git(beta, ["status", "--porcelain"]), "M README.md\n?? notes.txt");
    });

  it.effect("restores a worktree first attached in a rewound turn on each earlier rewind", () =>
    withHarness(({ fixture, agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const { threadId, alpha, beta } = yield* attachedInRewoundTurn(
          fixture,
          agent,
          "rewound-attach",
        );

        const first = yield* rollback(threadId, 1);
        assert.isNull(first.thread.rollbackFailure ?? null);
        assert.equal(first.runs.find((run) => run.ordinal === 2)?.status, "rolled_back");
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
        yield* expectBetaBaseline(beta);

        // A turn after the gap diffs beta against that baseline, and rewinding it finds it again.
        yield* runTurn(
          agent,
          threadId,
          Effect.gen(function* () {
            yield* write(path.join(alpha, "README.md"), "# alpha\nturn 4\n");
            yield* write(path.join(beta, "README.md"), "# beta\nearlier edit\nturn 4\n");
            yield* write(path.join(beta, "draft.txt"), "turn 4\n");
          }),
        );
        const fourth = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 4 });
        assert.include(fourth.diff, "diff --git a/beta/README.md b/beta/README.md");
        assert.include(fourth.diff, "+turn 4");
        assert.notInclude(fourth.diff, "+earlier edit");
        assert.notInclude(fourth.diff, "notes.txt");
        const second = yield* rollback(threadId, 1);
        assert.isNull(second.thread.rollbackFailure ?? null);
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
        yield* expectBetaBaseline(beta);

        const start = yield* rollback(threadId, 0);
        assert.isNull(start.thread.rollbackFailure ?? null);
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
        yield* expectBetaBaseline(beta);
        assert.deepEqual(yield* Ref.get(agent.nativeTurns), []);
        assert.equal(yield* Ref.get(agent.rollbacks), 4);
        // The source checkouts never change.
        assert.equal(yield* read(path.join(fixture.beta, "README.md")), "# beta\n");
        assert.equal(yield* git(fixture.beta, ["status", "--porcelain"]), "");
        assert.equal(yield* git(fixture.alpha, ["branch", "--show-current"]), "main");
      }),
    ),
  );

  it.effect(
    "refuses an earlier rewind whose first-attach baseline is gone, not using a newer snapshot",
    () =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const { threadId, alpha, beta, turnThree } = yield* attachedInRewoundTurn(
            fixture,
            agent,
            "rewound-attach-missing",
          );
          // The baseline is gone, while turn 3's edited snapshot outlived its rewind.
          const refs = (yield* git(beta, [
            "for-each-ref",
            "--format=%(refname)",
            "refs/t3/",
          ])).split("\n");
          assert.equal(refs.length, 1);
          yield* git(beta, ["update-ref", "-d", refs[0]!]);
          yield* git(beta, ["update-ref", turnThree.ref, turnThree.commit]);

          yield* rollback(threadId, 1);
          for (let attempt = 0; attempt < 5; attempt += 1) {
            yield* TestClock.adjust(Duration.seconds(31));
            yield* worker.drain();
          }
          const after = yield* projectionOf(threadId);
          assert.include(after.thread.rollbackFailure?.message ?? "", "No checkpoint of beta");
          assert.include(after.thread.rollbackFailure?.message ?? "", "Nothing was changed");
          assert.equal(after.runs.find((run) => run.ordinal === 2)?.status, "completed");
          assert.equal(yield* Ref.get(agent.rollbacks), 1);
          assert.equal((yield* Ref.get(agent.nativeTurns)).length, 2);
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 2\n");
          yield* expectBetaBaseline(beta);
        }),
      ),
  );

  it.effect.skipIf(!permissionsBlockWrites)(
    "retries an earlier rewind's file restore from the same first-attach baseline",
    () =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const { threadId, alpha, beta } = yield* attachedInRewoundTurn(
            fixture,
            agent,
            "rewound-attach-retry",
          );
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              yield* write(path.join(alpha, "README.md"), "# alpha\nturn 4\n");
              yield* write(path.join(beta, "README.md"), "# beta\nearlier edit\nturn 4\n");
              yield* write(path.join(beta, "draft.txt"), "turn 4\n");
            }),
          );
          const retained = (yield* Ref.get(agent.nativeTurns)).slice(0, 1);

          // Git can read beta but not replace its files.
          yield* fileSystem.chmod(beta, 0o555);
          yield* Effect.addFinalizer(() => fileSystem.chmod(beta, 0o755).pipe(Effect.ignore));
          const partial = yield* rollback(threadId, 1);
          assert.include(
            partial.thread.rollbackFailure?.message ?? "",
            "The conversation was rewound, but restoring files stopped at the beta worktree",
          );
          assert.include(partial.thread.rollbackFailure?.message ?? "", "Already restored: alpha.");
          assert.deepEqual(yield* Ref.get(agent.nativeTurns), retained);
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
          assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nearlier edit\nturn 4\n");

          // Fixed before the outbox's next attempt, which finishes the files.
          yield* fileSystem.chmod(beta, 0o755);
          yield* TestClock.adjust(Duration.seconds(31));
          yield* worker.drain();
          const finished = yield* projectionOf(threadId);
          assert.isNull(finished.thread.rollbackFailure ?? null);
          assert.equal(
            finished.checkpoints.find((checkpoint) => checkpoint.appRunOrdinal === 4)?.status,
            "stale",
          );
          assert.equal(yield* Ref.get(agent.rollbacks), 2);
          assert.deepEqual(yield* Ref.get(agent.nativeTurns), retained);
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
          yield* expectBetaBaseline(beta);
        }),
      ),
  );

  /**
   * Turn 1 attaches alpha, which is detached before turn 2, so turn 2 has no
   * worktrees. Turn 3 attaches alpha again and beta for the first time. Turn
   * 2's checkpoint borrows their attach snapshots, which is no sign that turn
   * 2 captured either one.
   */
  const detachedAllThenAttached = (agent: Agent, name: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
      const threadId = yield* createThread({ threadId: `thread:${name}` });
      const ensure = (repository: string) =>
        repoWorktrees
          .ensure({ threadId, repository, branch: `t3/${name}`, baseRef: "main" })
          .pipe(Effect.map((result) => result.repoWorktree.worktreePath));
      let alpha = "";
      let beta = "";
      yield* runTurn(
        agent,
        threadId,
        Effect.gen(function* () {
          alpha = yield* ensure("alpha");
          yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\n");
        }),
      );
      yield* repoWorktrees.detach({ threadId, worktreePath: alpha });
      assert.deepEqual((yield* projectionOf(threadId)).thread.repoWorktrees, []);
      yield* runTurn(agent, threadId, Effect.void);
      yield* runTurn(
        agent,
        threadId,
        Effect.gen(function* () {
          assert.equal(yield* ensure("alpha"), alpha);
          beta = yield* ensure("beta");
          yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\nturn 3\n");
          yield* write(path.join(beta, "README.md"), "# beta\nturn 3\n");
        }),
      );
      const borrowed = (yield* projectionOf(threadId)).checkpoints
        .find((checkpoint) => checkpoint.appRunOrdinal === 2)
        ?.repositories?.find((entry) => entry.repository === "beta");
      assert.isDefined(borrowed);
      return { threadId, alpha, beta, borrowed: borrowed! };
    });

  it.effect("restores an earlier turn after every worktree was detached and others attached", () =>
    withHarness(({ fixture, agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const { threadId, alpha, beta, borrowed } = yield* detachedAllThenAttached(
          agent,
          "detach-all",
        );

        const first = yield* rollback(threadId, 1);
        assert.isNull(first.thread.rollbackFailure ?? null);
        assert.deepEqual(
          first.runs.map((run) => run.status),
          ["completed", "rolled_back", "rolled_back"],
        );
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 1\n");
        assert.equal(yield* read(path.join(beta, "README.md")), "# beta\n");
        assert.equal((yield* Ref.get(agent.nativeTurns)).length, 1);

        // Beta's attach snapshot outlives that rewind: a later turn diffs
        // against it, and rewinding to the start restores it again.
        yield* runTurn(agent, threadId, write(path.join(beta, "README.md"), "# beta\nturn 4\n"));
        const fourth = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 4 });
        assert.include(fourth.diff, "+turn 4");
        assert.notInclude(fourth.diff, "turn 3");
        const start = yield* rollback(threadId, 0);
        assert.isNull(start.thread.rollbackFailure ?? null);
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
        assert.equal(yield* read(path.join(beta, "README.md")), "# beta\n");
        assert.deepEqual(yield* Ref.get(agent.nativeTurns), []);
        assert.equal(yield* Ref.get(agent.rollbacks), 2);
        assert.isTrue(borrowed.backfilled);
        for (const source of [fixture.alpha, fixture.beta]) {
          assert.equal(yield* git(source, ["status", "--porcelain"]), "");
          assert.equal(yield* git(source, ["branch", "--show-current"]), "main");
        }
      }),
    ),
  );

  it.effect.skipIf(!permissionsBlockWrites)(
    "finishes that rewind's file restore on a retry from the same attach snapshot",
    () =>
      withHarness(({ agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const { threadId, alpha, beta } = yield* detachedAllThenAttached(
            agent,
            "detach-all-retry",
          );
          // Git can read beta but not replace its files.
          yield* fileSystem.chmod(beta, 0o555);
          yield* Effect.addFinalizer(() => fileSystem.chmod(beta, 0o755).pipe(Effect.ignore));
          const partial = yield* rollback(threadId, 1);
          assert.include(
            partial.thread.rollbackFailure?.message ?? "",
            "restoring files stopped at the beta worktree",
          );
          assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 1\n");
          assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nturn 3\n");

          yield* fileSystem.chmod(beta, 0o755);
          yield* TestClock.adjust(Duration.seconds(31));
          yield* worker.drain();
          const finished = yield* projectionOf(threadId);
          assert.isNull(finished.thread.rollbackFailure ?? null);
          assert.equal(yield* read(path.join(beta, "README.md")), "# beta\n");
          // The provider already rewound; finishing the files does not ask it again.
          assert.equal(yield* Ref.get(agent.rollbacks), 1);
          assert.equal((yield* Ref.get(agent.nativeTurns)).length, 1);
        }),
      ),
  );

  it.effect("refuses that rewind once beta's attach snapshot is gone, not using a newer one", () =>
    withHarness(({ agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const { threadId, alpha, beta, borrowed } = yield* detachedAllThenAttached(
          agent,
          "detach-all-missing",
        );
        // Turn 3's own snapshot of beta, with its edit, is still there.
        yield* git(beta, ["update-ref", "-d", borrowed.ref]);

        yield* rollback(threadId, 1);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          yield* TestClock.adjust(Duration.seconds(31));
          yield* worker.drain();
        }
        const after = yield* projectionOf(threadId);
        assert.include(after.thread.rollbackFailure?.message ?? "", "No checkpoint of beta");
        assert.include(after.thread.rollbackFailure?.message ?? "", "Nothing was changed");
        assert.deepEqual(
          after.runs.map((run) => run.status),
          ["completed", "completed", "completed"],
        );
        assert.equal(yield* Ref.get(agent.rollbacks), 0);
        assert.equal((yield* Ref.get(agent.nativeTurns)).length, 3);
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 1\nturn 3\n");
        assert.equal(yield* read(path.join(beta, "README.md")), "# beta\nturn 3\n");
      }),
    ),
  );

  /**
   * Turn 1 leaves alpha's README with a kept line, and turn 2 adds one that
   * rewinding to turn 1 removes. With `lock`, a lock file on turn 2's
   * snapshot ref, as another Git process leaves, makes Git refuse to delete
   * that snapshot, so it still holds turn 2's edit where turn 3's baseline goes.
   */
  const rewindLeavingStaleSnapshot = (
    fixture: Fixture,
    agent: Agent,
    input: { readonly name: string; readonly ordinary: boolean; readonly lock: boolean },
  ) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
      const branch = `t3/${input.name}`;
      let cwd = path.join(fixture.worktrees, "alpha", input.name);
      let threadId: ThreadId;
      if (input.ordinary) {
        yield* createProject(alphaProjectId, fixture.alpha);
        yield* git(fixture.alpha, ["worktree", "add", "-b", branch, cwd]);
        threadId = yield* createThread({
          threadId: `thread:${input.name}`,
          projectId: alphaProjectId,
          worktreePath: cwd,
          branch,
        });
      } else {
        threadId = yield* createThread({ threadId: `thread:${input.name}` });
      }
      yield* runTurn(
        agent,
        threadId,
        Effect.gen(function* () {
          if (!input.ordinary) {
            cwd = (yield* repoWorktrees.ensure({
              threadId,
              repository: "alpha",
              branch,
              baseRef: "main",
            })).repoWorktree.worktreePath;
          }
          yield* write(path.join(cwd, "README.md"), "# alpha\nkept\n");
        }),
      );
      yield* runTurn(
        agent,
        threadId,
        write(path.join(cwd, "README.md"), "# alpha\nkept\nturn 2\n"),
      );
      const second = (yield* projectionOf(threadId)).checkpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === 2,
      );
      const ref = input.ordinary ? second!.ref : second!.repositories![0]!.ref;
      const lockPath = yield* git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `${ref}.lock`,
      ]);
      if (input.lock) {
        yield* write(lockPath, "held by another Git process\n");
        yield* Effect.addFinalizer(() => fileSystem.remove(lockPath).pipe(Effect.ignore));
      }

      const rewound = yield* rollback(threadId, 1);
      assert.isNull(rewound.thread.rollbackFailure ?? null);
      assert.equal(
        rewound.checkpoints.find((checkpoint) => checkpoint.appRunOrdinal === 2)?.status,
        "stale",
      );
      assert.equal(yield* read(path.join(cwd, "README.md")), "# alpha\nkept\n");
      assert.equal(
        yield* git(cwd, ["for-each-ref", "--format=%(refname)", ref]),
        input.lock ? ref : "",
      );
      return { threadId, cwd, ref, lockPath, prefix: input.ordinary ? "" : "alpha/" };
    });
  const expectSourceUnchanged = (fixture: Fixture) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(yield* read(path.join(fixture.alpha, "README.md")), "# alpha\n");
      assert.equal(yield* git(fixture.alpha, ["status", "--porcelain"]), "");
      assert.equal(yield* git(fixture.alpha, ["branch", "--show-current"]), "main");
    });
  const turnCounts = (threadId: ThreadId, turn: number) =>
    projectionOf(threadId).pipe(
      Effect.map((projection) =>
        projection.checkpoints
          .find((checkpoint) => checkpoint.appRunOrdinal === turn)
          ?.files.map((file) => [file.path, file.additions, file.deletions]),
      ),
    );

  it.effect.each([
    { worktree: "repository", lock: "released" },
    { worktree: "repository", lock: "none" },
    { worktree: "ordinary", lock: "released" },
    { worktree: "ordinary", lock: "none" },
  ] as const)(
    "baselines the turn after a $worktree worktree rewind on its restored files, lock $lock",
    ({ worktree, lock }) =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          const { threadId, cwd, ref, lockPath, prefix } = yield* rewindLeavingStaleSnapshot(
            fixture,
            agent,
            {
              name: `stale-${worktree}-${lock}`,
              ordinary: worktree === "ordinary",
              lock: lock !== "none",
            },
          );
          // Another Git process lets go before the next turn.
          if (lock === "released") yield* fileSystem.remove(lockPath);

          let baseline = "";
          yield* runTurn(
            agent,
            threadId,
            Effect.gen(function* () {
              baseline = yield* git(cwd, ["show", `${ref}:README.md`]);
              yield* write(path.join(cwd, "README.md"), "# alpha\nkept\nturn 3\n");
            }),
          );
          assert.equal(baseline, "# alpha\nkept");
          assert.deepEqual(yield* turnCounts(threadId, 3), [[`${prefix}README.md`, 1, 0]]);
          const diff = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 3 });
          assert.include(diff.diff, "+turn 3");
          assert.notInclude(diff.diff, "turn 2");

          const again = yield* rollback(threadId, 1);
          assert.isNull(again.thread.rollbackFailure ?? null);
          assert.equal(yield* read(path.join(cwd, "README.md")), "# alpha\nkept\n");
          yield* expectSourceUnchanged(fixture);
        }),
      ),
  );

  it.effect.each(["repository", "ordinary"] as const)(
    "leaves a %s worktree turn uncounted, not miscounted, while its stale baseline stays locked",
    (worktree) =>
      withHarness(({ fixture, agent }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          const { threadId, cwd, ref, lockPath, prefix } = yield* rewindLeavingStaleSnapshot(
            fixture,
            agent,
            { name: `locked-${worktree}`, ordinary: worktree === "ordinary", lock: true },
          );

          // Capture retries a locked ref after a short real delay before it gives up.
          yield* TestClock.withLive(
            runTurn(agent, threadId, write(path.join(cwd, "README.md"), "# alpha\nkept\nturn 3\n")),
          );
          // Git could not replace the stale snapshot, and nothing calls it a baseline.
          assert.equal(yield* git(cwd, ["show", `${ref}:README.md`]), "# alpha\nkept\nturn 2");
          assert.deepEqual(yield* turnCounts(threadId, 3), []);
          const third = yield* projectionOf(threadId);
          assert.notInclude(
            third.checkpoints
              .filter((checkpoint) => checkpoint.ordinalWithinScope === 2)
              .map((checkpoint) => checkpoint.status),
            "ready",
          );
          const diff = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 3 });
          assert.include(diff.diff, "+turn 3");
          assert.notInclude(diff.diff, "turn 2");

          // Once Git lets go, the next turn counts against turn 3's own snapshot.
          yield* fileSystem.remove(lockPath);
          yield* runTurn(
            agent,
            threadId,
            write(path.join(cwd, "README.md"), "# alpha\nkept\nturn 3\nturn 4\n"),
          );
          assert.deepEqual(yield* turnCounts(threadId, 4), [[`${prefix}README.md`, 1, 0]]);
          const again = yield* rollback(threadId, 1);
          assert.isNull(again.thread.rollbackFailure ?? null);
          assert.equal(yield* read(path.join(cwd, "README.md")), "# alpha\nkept\n");
          yield* expectSourceUnchanged(fixture);
        }),
      ),
  );

  it.effect("recovers a rewind whose reply was lost without removing earlier turns", () =>
    withHarness(({ agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* createThread({ threadId: "thread:lost-reply" });
        // History the provider thread started with, as a fork's does.
        yield* Ref.set(agent.nativeTurns, ["native:inherited"]);
        let alpha = "";
        yield* runTurn(
          agent,
          threadId,
          Effect.gen(function* () {
            alpha = (yield* repoWorktrees.ensure({
              threadId,
              repository: "alpha",
              branch: "t3/lost-reply",
              baseRef: "main",
            })).repoWorktree.worktreePath;
            yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\n");
          }),
        );
        yield* runTurn(agent, threadId, write(path.join(alpha, "README.md"), "# alpha\nturn 2\n"));

        yield* Ref.set(agent.loseNextRevertReply, true);
        const lost = yield* rollback(threadId, 0);
        // Codex rewound, but without its reply nothing was recorded or restored.
        assert.deepEqual(yield* Ref.get(agent.nativeTurns), ["native:inherited"]);
        assert.deepEqual(
          lost.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 2\n");

        yield* TestClock.adjust(Duration.seconds(31));
        yield* worker.drain();
        const recovered = yield* projectionOf(threadId);
        assert.equal(yield* Ref.get(agent.rollbacks), 2);
        assert.deepEqual(yield* Ref.get(agent.nativeTurns), ["native:inherited"]);
        assert.deepEqual(
          recovered.runs.map((run) => run.status),
          ["rolled_back", "rolled_back"],
        );
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\n");
      }),
    ),
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
  );

  it.effect("recreates a removed worktree on the branch a Git action switched it to", () =>
    withHarness(({ agent }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const repoWorktrees = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread({ threadId: "thread:switched" });
        let alpha = "";
        yield* runTurn(
          agent,
          threadId,
          Effect.gen(function* () {
            alpha = (yield* repoWorktrees.ensure({
              threadId,
              repository: "alpha",
              branch: "t3/before",
              baseRef: "main",
            })).repoWorktree.worktreePath;
            yield* write(path.join(alpha, "README.md"), "# alpha\nturn 1\n");
          }),
        );
        yield* runTurn(agent, threadId, write(path.join(alpha, "README.md"), "# alpha\nturn 2\n"));
        // As "Commit on new branch" does from the thread's Changes view.
        yield* git(alpha, ["switch", "--quiet", "-c", "t3/after"]);
        yield* repoWorktrees.recordBranch({ cwd: alpha });
        yield* fileSystem.remove(alpha, { recursive: true });

        yield* rollback(threadId, 1);
        assert.equal(yield* git(alpha, ["branch", "--show-current"]), "t3/after");
        assert.equal(yield* read(path.join(alpha, "README.md")), "# alpha\nturn 1\n");
      }),
    ),
  );

  it.effect("rejects rollback for a provider that cannot rewind before any file changes", () =>
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
  );
});
