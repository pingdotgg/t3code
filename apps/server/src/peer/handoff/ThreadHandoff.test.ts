import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadImportService from "../../orchestration-v2/ThreadImportService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  type CapturedTurn,
  makeCapturingCodexAdapter,
} from "../../orchestration-v2/testkit/CapturingCodexAdapter.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as PeerForwarding from "../PeerForwarding.ts";
import * as PeerLinks from "../PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "../PeerLinks.testkit.ts";
import * as RemoteDelegation from "../RemoteDelegation.ts";
import * as ThreadHandoff from "./ThreadHandoff.ts";

// A thread on the laptop moves to the box: both are real orchestrators, the
// box behind its real /mcp, OAuth and upload route, the laptop linked to it,
// and both with a real clone of the same repository. The thread arrives with
// its conversation and its git work, and only one copy stays live.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const git = (cwd: string, args: ReadonlyArray<string>) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((processes) =>
      processes.run({
        operation: "ThreadHandoff.test",
        command: "git",
        cwd,
        args,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      }),
    ),
    Effect.map((result) => result.stdout),
    Effect.orDie,
  );

/** An origin and the laptop's and the box's clones of it. */
const makeRepos = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-handoff-" });
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  yield* fileSystem.makeDirectory(seed);
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  yield* git(seed, ["init", "--quiet", "--initial-branch=main"]);
  yield* fileSystem.writeFileString(path.join(seed, "app.ts"), "export const version = 1;\n");
  yield* git(seed, ["add", "."]);
  yield* git(seed, ["commit", "--quiet", "-m", "start"]);
  yield* git(seed, ["remote", "add", "origin", origin]);
  yield* git(seed, ["push", "--quiet", "origin", "main"]);
  const laptopRepo = path.join(root, "laptop");
  const boxRepo = path.join(root, "box");
  yield* git(root, ["clone", "--quiet", origin, laptopRepo]);
  yield* git(root, ["clone", "--quiet", origin, boxRepo]);
  return { root, laptopRepo, boxRepo };
});

const projectAt = (id: string, workspaceRoot: string): Project => ({
  id: ProjectId.make(id),
  title: "app",
  workspaceRoot,
  // Blank, as a cold enrichment cache leaves it: both sides resolve the
  // clones' shared origin themselves.
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
});

const layerProjects = (project: Project) =>
  Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
    snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
  });

/** What each test runs on: a test HTTP server, git, and Node. */
const layerTestHost = Layer.mergeAll(NodeHttpServer.layerTest, VcsProcess.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** A real orchestrator on an in-memory database, with a capturing provider. */
const layerOrchestration = (
  name: string,
  workspace: string,
  captured: Ref.Ref<ReadonlyArray<CapturedTurn>>,
  holdTurn?: Effect.Effect<void>,
) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerStores = Layer.mergeAll(
    layerDatabase,
    EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
    ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  );
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    {
      name,
      runtimePolicyOverride: {
        cwd: workspace,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    ProviderAdapterRegistry.layerSingle(
      makeCapturingCodexAdapter(captured, {
        response: `${name} replied.`,
        modelSelection,
        ...(holdTurn === undefined ? {} : { holdTurn }),
      }),
    ),
    { databaseLayer: layerDatabase },
  );
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(layerOrchestrator),
    Layer.provideMerge(EventSink.layer.pipe(Layer.provide(layerStores))),
    Layer.provideMerge(layerStores),
  );
};

const unusedServices = Layer.mergeAll(
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(PeerForwarding.PeerForwarding)({}),
);

/** The box: its real tools on a real /mcp, with uploads, on its own repo. */
const serveBox = (
  boxRepo: string,
  stateDir: string,
  captured: Ref.Ref<ReadonlyArray<CapturedTurn>>,
) =>
  Effect.gen(function* () {
    const core = yield* Layer.mergeAll(
      ThreadImportService.layer.pipe(
        Layer.provideMerge(layerOrchestration("box", boxRepo, captured)),
      ),
      VcsProcess.layer,
      ServerSettings.layerTest(),
    ).pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.build,
    );
    const layerCore = Layer.succeedContext(core);
    const tools = Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerAttachmentRegistration,
    ).pipe(
      Layer.provide(layerProjects(projectAt("project:box", boxRepo))),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listWorktreePaths: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(unusedServices),
      Layer.provide(layerCore),
      Layer.provide(NodeCrypto.layer),
    );
    // Upload URLs are signed and checked with the box's own secret store.
    const served = yield* servePeer(box, tools, ServerHttp.layerAttachmentUploadRoute, core).pipe(
      Effect.provide(layerCore),
    );
    return {
      ...served,
      orchestrator: Context.get(core, Orchestrator.OrchestratorV2),
    };
  });

/** The laptop: a real orchestrator with a thread mid-conversation, linked to the box. */
const makeLaptop = (
  laptopRepo: string,
  captured: Ref.Ref<ReadonlyArray<CapturedTurn>>,
  holdTurn?: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const core = yield* layerOrchestration("laptop", laptopRepo, captured, holdTurn).pipe(
      Layer.provideMerge(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-laptop-" }),
          ),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.build,
    );
    const layerHere = ThreadHandoff.layer.pipe(
      Layer.provideMerge(PeerForwarding.layer),
      Layer.provide(layerProjects(projectAt("project:laptop", laptopRepo))),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(laptop.environmentId),
          getDescriptor: Effect.succeed(laptop),
        }),
      ),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(Layer.succeedContext(core)),
      Layer.provide(VcsProcess.layer),
      Layer.provide(NodeCrypto.layer),
      // Uploads go to the box's own address, not the test server's.
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      orchestrator: Context.get(core, Orchestrator.OrchestratorV2),
      threads: Context.get(core, ThreadManagement.ThreadManagementService),
      handoff: Context.get(here, ThreadHandoff.ThreadHandoff),
    };
  });

const threadId = ThreadId.make("thread:laptop-login");

/** The laptop's thread: one finished turn about the bug, on the laptop's checkout. */
const createThread = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  laptopRepo: string,
) =>
  laptopEnv.orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:create:laptop-login"),
    threadId,
    projectId: ProjectId.make("project:laptop"),
    title: "Flaky login test",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: laptopRepo,
  });

const seedThread = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>, laptopRepo: string) =>
  Effect.gen(function* () {
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop-login"),
      threadId,
      projectId: ProjectId.make("project:laptop"),
      title: "Flaky login test",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: laptopRepo,
    });
    yield* laptopEnv.orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:send:laptop-login"),
      threadId,
      messageId: MessageId.make("message:laptop-login:1"),
      text: "LAPTOP_QUESTION: why does the login test flake?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    yield* idle(laptopEnv.orchestrator, threadId);
  });

/** Polls `check` until it holds; for states only another fiber reaches. */
const waitFor = <E>(check: Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (yield* check.pipe(Effect.orElseSucceed(() => false))) return;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error("The awaited state never came."));
  });

const idle = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: ThreadId) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const projection: OrchestrationV2ThreadProjection =
        yield* orchestrator.getThreadProjection(id);
      if (
        projection.runs.length > 0 &&
        projection.runs.every(
          (run) => !["queued", "starting", "running", "waiting", "preparing"].includes(run.status),
        )
      ) {
        return projection;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`${id} never went idle.`));
  });

it.live("a thread moves to the box with its conversation and its git work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const boxTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const laptopTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), boxTurns);
      const a = yield* makeLaptop(laptopRepo, laptopTurns);
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);

      // The thread's work on the laptop: an unpushed commit, then uncommitted edits.
      yield* git(laptopRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 2;\n",
      );
      yield* git(laptopRepo, ["commit", "--quiet", "-am", "unpushed fix"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 3;\n",
      );
      yield* fileSystem.writeFileString(path.join(laptopRepo, "notes.md"), "# findings\n");

      expect(yield* a.handoff.options(threadId)).toEqual([
        { environmentId: box.environmentId, label: "Box", projectId: "project:box", reason: null },
      ]);
      const moved = yield* a.handoff.start({ threadId, environmentId: box.environmentId });
      expect(moved.state).toBe("departed");
      if (moved.state !== "departed") return;

      // On the box: the thread, its history, its first run with that context.
      const there = yield* idle(b.orchestrator, moved.threadId);
      expect(there.thread.historyOrigin).toBe("v1_import");
      expect(there.messages.some((message) => message.text.includes("LAPTOP_QUESTION"))).toBe(true);
      const [firstTurn] = yield* Ref.get(boxTurns);
      expect(firstTurn?.text).toContain("LAPTOP_QUESTION");
      expect(firstTurn?.text).toContain("Continue where it left off.");
      // ...in a new worktree on the branch, with the commit and the edits.
      const worktree = there.thread.worktreePath!;
      expect(there.thread.branch).toBe("fix/login");
      expect((yield* git(worktree, ["log", "-1", "--format=%s"])).trim()).toBe("unpushed fix");
      expect(yield* fileSystem.readFileString(path.join(worktree, "app.ts"))).toBe(
        "export const version = 3;\n",
      );
      expect(yield* fileSystem.readFileString(path.join(worktree, "notes.md"))).toBe(
        "# findings\n",
      );

      // On the laptop: read-only, pointing at the box.
      const here = yield* a.orchestrator.getThreadProjection(threadId);
      expect(here.thread.handoff).toMatchObject({ state: "departed", threadId: moved.threadId });
      const refused = yield* a.orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:send:after-move"),
          threadId,
          messageId: MessageId.make("message:after-move"),
          text: "Still here?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      expect(refused.message).toBe("This thread moved to Box. Continue it there.");
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a move the box refuses releases the thread here, untouched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      const a = yield* makeLaptop(laptopRepo, turns);
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      // The box has its own commit on the branch the laptop's thread is on.
      yield* git(laptopRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 2;\n",
      );
      yield* git(laptopRepo, ["commit", "--quiet", "-am", "laptop fix"]);
      yield* git(boxRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(path.join(boxRepo, "box.ts"), "export const b = 1;\n");
      yield* git(boxRepo, ["add", "."]);
      yield* git(boxRepo, ["commit", "--quiet", "-m", "box fix"]);
      yield* git(boxRepo, ["checkout", "--quiet", "main"]);

      const failed = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(failed.message).toContain("commits the handed-off work lacks");
      const here = yield* a.orchestrator.getThreadProjection(threadId);
      expect(here.thread.handoff).toMatchObject({ state: "failed" });
      // Released: the thread takes turns here again.
      yield* a.orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:send:after-failure"),
        threadId,
        messageId: MessageId.make("message:after-failure"),
        text: "Keep going here then.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      // Nothing was created on the box.
      expect(
        (yield* b.orchestrator.getShellSnapshot()).threads.filter((shell) =>
          shell.title.includes("Flaky"),
        ),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("an agent's own move waits for its turn to end, and a message before then cancels it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      // The laptop's turns stay open until the test lets one finish; each
      // release lets exactly one waiting turn end.
      const releases = yield* Queue.unbounded<void>();
      const hold = Queue.take(releases);
      const releaseTurn = Queue.offer(releases, undefined);
      const a = yield* makeLaptop(laptopRepo, turns, hold);
      yield* linkTo(a.links, b, "full-access");
      yield* a.handoff.start_();
      yield* createThread(a, laptopRepo);
      const send = (id: string, text: string) =>
        a.orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:send:${id}`),
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
      const handoffState = a.orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map((projection) => projection.thread.handoff?.state ?? null));
      const askToMove = a.handoff.start({
        threadId,
        environmentId: box.environmentId,
        whenTurnEnds: true,
        continuationPrompt: "SELF_HANDOFF_CONTINUE: run the e2e suite there.",
      });

      // Mid-turn, the agent asks to move: nothing moves yet.
      yield* send("turn-1", "Wrap up and move this to the box.");
      yield* waitFor(
        a.orchestrator
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) => projection.runs.some((run) => run.status === "running")),
          ),
      );
      expect((yield* askToMove).state).toBe("pending");
      // An agent the user works through steers the same turn before it ends:
      // new instructions win.
      yield* waitFor(
        a.orchestrator
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            ),
          ),
      );
      const running = (yield* a.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "running",
      );
      if (running === undefined) return yield* Effect.die("no running turn");
      yield* Effect.sleep("2 millis");
      yield* a.orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "web",
        commandId: CommandId.make("command:send:steer"),
        threadId,
        messageId: MessageId.make("message:steer"),
        text: "Actually, stay here.",
        attachments: [],
        dispatchMode: { type: "steer_active", targetRunId: running.id },
      });
      yield* releaseTurn;
      yield* waitFor(handoffState.pipe(Effect.map((state) => state === null)));
      yield* idle(a.orchestrator, threadId);
      expect(yield* handoffState).toBe(null);

      // Asked again, with nothing after it: it moves once the turn ends.
      yield* send("turn-3", "Now move it.");
      yield* waitFor(
        a.orchestrator
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) => projection.runs.some((run) => run.status === "running")),
          ),
      );
      expect((yield* askToMove).state).toBe("pending");
      // Settling it while the turn still runs, as a restart's sweep does, leaves it waiting.
      yield* a.handoff.settle(threadId);
      expect(yield* handoffState).toBe("pending");
      yield* releaseTurn;
      yield* waitFor(handoffState.pipe(Effect.map((state) => state === "departed")));
      const moved = (yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff;
      if (moved?.state !== "departed") return yield* Effect.die("not departed");
      yield* idle(b.orchestrator, moved.threadId);
      // The box's first turn is the agent's own continuation.
      expect((yield* Ref.get(turns)).at(-1)?.text).toContain("SELF_HANDOFF_CONTINUE");
    }),
  ).pipe(Effect.provide(layerTestHost)),
);
