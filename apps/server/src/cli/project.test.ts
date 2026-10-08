import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentInternalError,
  EventId,
  ProviderInstanceId,
  Project,
  ProjectMutation,
  ProjectSnapshot,
  ThreadId,
  type OrchestrationV2AppThread,
  type ProjectId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const readProjects = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = RuntimeLayer.layerProjectService.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    return yield* ProjectService.ProjectService.pipe(
      Effect.flatMap((projects) => projects.snapshot),
      Effect.provide(layer),
    );
  });

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "access_token_issuance_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it.effect("adds, renames, and removes projects through the V2 project CLI domain", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-workspace-"),
    );

    yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", "--base-dir", baseDir]);
    const added = (yield* readProjects(baseDir)).projects[0];
    assert.equal(added?.title, "Alpha");
    assert.equal(added?.workspaceRoot, workspaceRoot);

    yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
    assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Beta");

    yield* runCli(["project", "remove", added?.id ?? "", "--base-dir", baseDir]);
    assert.deepEqual((yield* readProjects(baseDir)).projects, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeProjectLookupFixture = Effect.fn("ProjectCliTest.makeProjectLookupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-lookup-" });
  const baseDir = NodePath.join(root, "state");
  const workspaceRoot = NodePath.join(root, "workspace");
  yield* fs.makeDirectory(workspaceRoot);
  yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const project = (yield* readProjects(baseDir)).projects[0];
  assert.isDefined(project);
  return { baseDir, workspaceRoot, project: project! };
});

const makeThreadPersistenceLayer = Effect.fn("ProjectCliTest.makeThreadPersistenceLayer")(
  function* (baseDir: string) {
    const config = yield* makeConfig(baseDir);
    return Layer.mergeAll(
      RuntimeLayer.layerEventSink,
      ProjectionStore.layer,
      EventStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
  },
);

const seedNativeThreads = Effect.fn("ProjectCliTest.seedNativeThreads")(function* (
  baseDir: string,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archived: boolean;
  }>,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  const createdAt = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  yield* Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      commandId: CommandId.make("project-cli-seed-threads"),
      events: threads.map(({ id, projectId, archived }) => {
        const payload: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId,
          title: id,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: archived ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        return {
          id: EventId.make(`project-cli-create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          providerInstanceId,
          occurredAt: createdAt,
          payload,
        };
      }),
    });
  }).pipe(Effect.provide(layer));
});

const readNativeThreadState = Effect.fn("ProjectCliTest.readNativeThreadState")(function* (
  baseDir: string,
  threadId: ThreadId,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  return yield* Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    return {
      thread: yield* projections.getThread(threadId),
      events: yield* events.read({ threadId }).pipe(Stream.runCollect),
    };
  }).pipe(Effect.provide(layer));
});

it.layer(NodeServices.layer)("project deletion with native V2 threads", (it) => {
  it.effect.each([
    { label: "an active thread", archived: false, missing: false },
    { label: "an archived thread", archived: true, missing: false },
    {
      label: "an active thread after its workspace disappears",
      archived: false,
      missing: true,
    },
    {
      label: "an archived thread after its workspace disappears",
      archived: true,
      missing: true,
    },
  ])("rejects unforced removal of a project with $label", ({ archived, missing }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const threadId = ThreadId.make("project-cli-preserved-thread");
      yield* seedNativeThreads(baseDir, [{ id: threadId, projectId: project.id, archived }]);
      const before = yield* readNativeThreadState(baseDir, threadId);
      if (missing) yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);

      const error = yield* runCli([
        "project",
        "remove",
        missing ? workspaceRoot : project.id,
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Removing a nonempty project must require --force."),
        }),
      );

      assert.include(error.message, "not empty");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual(yield* readNativeThreadState(baseDir, threadId), before);
      assert.equal(yield* fs.exists(workspaceRoot), !missing);
    }),
  );

  it.effect.each(["present", "missing"] as const)(
    "force-removes active and archived V2 threads with the workspace %s, preserving unrelated projects",
    (workspace) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const otherWorkspace = `${workspaceRoot}-other`;
        yield* fs.makeDirectory(otherWorkspace);
        yield* runCli(["project", "add", otherWorkspace, "--base-dir", baseDir]);
        const otherProject = (yield* readProjects(baseDir)).projects.find(
          (entry) => entry.workspaceRoot === otherWorkspace,
        );
        assert.isDefined(otherProject);
        const activeId = ThreadId.make("project-cli-deleted-active");
        const archivedId = ThreadId.make("project-cli-deleted-archived");
        const unrelatedId = ThreadId.make("project-cli-unrelated-thread");
        yield* seedNativeThreads(baseDir, [
          { id: activeId, projectId: project.id, archived: false },
          { id: archivedId, projectId: project.id, archived: true },
          { id: unrelatedId, projectId: otherProject!.id, archived: false },
        ]);
        const unrelatedBefore = yield* readNativeThreadState(baseDir, unrelatedId);
        if (workspace === "missing") {
          yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        }

        yield* runCli([
          "project",
          "remove",
          workspace === "missing" ? workspaceRoot : project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]);

        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [otherProject!.id],
        );
        for (const threadId of [activeId, archivedId]) {
          const state = yield* readNativeThreadState(baseDir, threadId);
          assert.isNotNull(state.thread.deletedAt);
          assert.lengthOf(
            state.events.filter((record) => record.event.type === "thread.deleted"),
            1,
          );
        }
        assert.deepEqual(yield* readNativeThreadState(baseDir, unrelatedId), unrelatedBefore);
        assert.equal(yield* fs.exists(workspaceRoot), workspace === "present");
        assert.isTrue(yield* fs.exists(otherWorkspace));
      }),
  );
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect.each(["id", "stored path"] as const)(
    "removes an empty project by %s after its directory is gone",
    (identifier) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        yield* runCli([
          "project",
          "remove",
          identifier === "id" ? project.id : workspaceRoot,
          "--base-dir",
          baseDir,
        ]);
        assert.deepEqual((yield* readProjects(baseDir)).projects, []);
        assert.isFalse(yield* fs.exists(workspaceRoot));
      }),
  );

  it.effect("renames by ID and stored path after the directory is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      for (const [identifier, title] of [
        [project.id, "Renamed by ID"],
        [workspaceRoot, "Renamed by stored path"],
      ] as const) {
        yield* runCli(["project", "rename", identifier, title, "--base-dir", baseDir]);
        assert.equal((yield* readProjects(baseDir)).projects[0]?.title, title);
      }
      assert.isFalse(yield* fs.exists(workspaceRoot));
    }),
  );

  it.effect("does not resolve another environment's project ID in an empty database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      const replacementDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-empty-" });
      const error = yield* runCli([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual((yield* readProjects(replacementDir)).projects, []);
    }),
  );

  it.effect("normalizes existing paths without conflating separately registered symlinks", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* runCli([
        "project",
        "rename",
        `${workspaceRoot}${NodePath.sep}.`,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Normalized");
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const unknownAlias = yield* runCli([
        "project",
        "remove",
        aliasPath,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(unknownAlias.message, "No active project found");
      yield* runCli(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = (yield* readProjects(baseDir)).projects;
      assert.equal(added.length, 2);
      const aliasProject = added.find((entry) => entry.workspaceRoot === aliasPath);
      assert.isDefined(aliasProject);
      assert.notEqual(aliasProject?.id, project.id);
      yield* runCli(["project", "remove", `${aliasPath}${NodePath.sep}.`, "--base-dir", baseDir]);
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});

const withPrimaryServer = <A, E, R>(
  handler: NodeHttp.RequestListener,
  run: (port: number) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(address.port);
    },
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const runtimeStatePath = (baseDir: string) =>
  NodePath.join(baseDir, "userdata", "server-runtime.json");

const persistPrimaryDescriptor = Effect.fn("ProjectCliTest.persistPrimaryDescriptor")(function* (
  baseDir: string,
  input: { readonly port: number; readonly pid: number },
) {
  const statePath = runtimeStatePath(baseDir);
  const state = yield* makePersistedServerRuntimeState({
    config: { host: "127.0.0.1", devUrl: undefined },
    port: input.port,
  });
  yield* persistServerRuntimeState({ path: statePath, state: { ...state, pid: input.pid } });
  return { statePath, bytes: NodeFS.readFileSync(statePath) };
});

const encodeProjectSnapshot = Schema.encodeUnknownSync(ProjectSnapshot);
const decodeProjectSnapshot = Schema.decodeUnknownSync(ProjectSnapshot);
const encodeProject = Schema.encodeUnknownSync(Project);
const decodeProject = Schema.decodeUnknownSync(Project);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);

// pid 2**22 + 1 exceeds any default Linux/macOS pid range. It also stands for a
// primary in another pid namespace, which the CLI cannot see either.
const DEAD_PID = 4_194_305;

const runCliCapturingOutput = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // Console output accumulates across CLI runs within a test.
    const earlier = (yield* TestConsole.logLines).length;
    // The CLI request timeout runs on the live clock, like the native executable.
    const exit = yield* Effect.exit(TestClock.withLive(runCli(args)));
    const lines = (yield* TestConsole.logLines)
      .slice(earlier)
      .filter((line): line is string => typeof line === "string");
    return { exit, output: lines.join("\n") };
  });

const assertFailedWith = (exit: Exit.Exit<unknown, unknown>, tag: string): Error => {
  if (!Exit.isFailure(exit)) {
    return assert.fail(`Expected the command to fail with ${tag}.`);
  }
  const error = Cause.squash(exit.cause);
  assert.propertyVal(error, "_tag", tag);
  return error as Error;
};

type FakePrimaryMutationResponse = "answer" | "drop after commit" | "stall after commit";

/**
 * An HTTP primary that serves the V2 project snapshot and applies
 * `project.create` to its own state before responding, so tests observe what
 * the primary holds afterwards rather than only what the CLI sent.
 */
const makeFakePrimary = (
  initial: ProjectSnapshot,
  mutationResponse: FakePrimaryMutationResponse = "answer",
) => {
  let projects: ReadonlyArray<Project> = initial.projects;
  const mutations: Array<ProjectMutation> = [];
  const handler: NodeHttp.RequestListener = (request, response) => {
    if (request.method === "GET" && request.url === "/api/projects") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(encodeProjectSnapshot({ projects, updatedAt: initial.updatedAt })),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/projects/mutate") {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const mutation = decodeProjectMutation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        mutations.push(mutation);
        if (mutation.type !== "project.create") {
          response.writeHead(400);
          response.end();
          return;
        }
        const created = decodeProject({
          id: mutation.projectId,
          title: mutation.title,
          workspaceRoot: mutation.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-08T12:00:00.000Z",
          updatedAt: "2026-10-08T12:00:00.000Z",
          deletedAt: null,
        });
        projects = [...projects, created];
        if (mutationResponse === "drop after commit") {
          request.socket.destroy();
          return;
        }
        if (mutationResponse === "stall after commit") {
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(encodeProject(created)));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  };
  return { handler, mutations };
};

// Reads what the primary holds through its own snapshot endpoint.
const readPrimarySnapshot = (port: number) =>
  Effect.callback<ProjectSnapshot>((resume) => {
    NodeHttp.get(`http://127.0.0.1:${port}/api/projects`, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resume(
          Effect.sync(() =>
            decodeProjectSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
          ),
        ),
      );
    }).on("error", (error) => resume(Effect.die(error)));
  });

const addNextWorkspace = (baseDir: string, workspaceRoot: string) => {
  const nextWorkspace = `${workspaceRoot}-next`;
  NodeFS.mkdirSync(nextWorkspace);
  return runCliCapturingOutput(["project", "add", nextWorkspace, "--base-dir", baseDir]).pipe(
    Effect.map((result) => ({ ...result, nextWorkspace })),
  );
};

it.layer(NodeServices.layer)("project registration against a persisted primary", (it) => {
  it.effect.each([
    // Accepts the request and never answers, like a primary paused under load.
    {
      failure: "a live primary does not answer",
      pid: process.pid,
      handler: (() => undefined) as NodeHttp.RequestListener,
    },
    {
      failure: "a live primary drops the connection",
      pid: process.pid,
      handler: ((request) => request.socket.destroy()) as NodeHttp.RequestListener,
    },
    // A pid the CLI cannot see proves nothing: the primary may run in another
    // pid namespace, so a dead-looking pid must not authorize an offline write.
    {
      failure: "the recorded pid is not visible",
      pid: DEAD_PID,
      handler: ((request) => request.socket.destroy()) as NodeHttp.RequestListener,
    },
  ])("keeps the descriptor and writes no project when $failure", ({ handler, pid }) =>
    withPrimaryServer(handler, (port) =>
      Effect.gen(function* () {
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const descriptor = yield* persistPrimaryDescriptor(baseDir, { port, pid });

        const { exit, output } = yield* addNextWorkspace(baseDir, workspaceRoot);

        const error = assertFailedWith(exit, "ProjectLiveServerUnavailableError");
        assert.include(error.message, "No project change was sent or written offline");
        assert.notInclude(output, "Added project");
        assert.deepEqual(NodeFS.readFileSync(descriptor.statePath), descriptor.bytes);
        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [project.id],
        );
      }),
    ),
  );

  it.effect("keeps a descriptor whose origin no longer listens and writes no project", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      // Reserve a port, then release it so nothing answers on the recorded origin.
      const port = yield* withPrimaryServer(
        () => undefined,
        (port) => Effect.succeed(port),
      );
      const descriptor = yield* persistPrimaryDescriptor(baseDir, { port, pid: DEAD_PID });

      const { exit, output } = yield* addNextWorkspace(baseDir, workspaceRoot);

      assertFailedWith(exit, "ProjectLiveServerUnavailableError");
      assert.notInclude(output, "Added project");
      assert.deepEqual(NodeFS.readFileSync(descriptor.statePath), descriptor.bytes);
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
    }),
  );

  it.effect.each([
    { state: "is not JSON", write: (path: string) => NodeFS.writeFileSync(path, "{not json") },
    {
      state: "does not match the runtime schema",
      write: (path: string) => NodeFS.writeFileSync(path, JSON.stringify({ version: 2, pid: 1 })),
    },
    { state: "is empty", write: (path: string) => NodeFS.writeFileSync(path, "") },
    { state: "cannot be read as a file", write: (path: string) => NodeFS.mkdirSync(path) },
  ])("writes no project when the runtime state $state", ({ write }) =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const statePath = runtimeStatePath(baseDir);
      NodeFS.mkdirSync(NodePath.dirname(statePath), { recursive: true });
      write(statePath);
      const before = NodeFS.statSync(statePath).isFile() ? NodeFS.readFileSync(statePath) : null;

      const { exit, output } = yield* addNextWorkspace(baseDir, workspaceRoot);

      const error = assertFailedWith(exit, "ProjectRuntimeStateUnreadableError");
      assert.include(error.message, statePath);
      assert.notInclude(output, "Added project");
      assert.isTrue(NodeFS.existsSync(statePath), "The runtime state must not be removed.");
      if (before !== null) {
        assert.deepEqual(NodeFS.readFileSync(statePath), before);
      }
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
    }),
  );

  it.effect("does not take over a descriptor that a new primary wrote during the attempt", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const statePath = runtimeStatePath(baseDir);
      let successor: Buffer | undefined;
      yield* withPrimaryServer(
        (request) => {
          // The recorded primary is gone; a successor claims ownership mid-request.
          NodeFS.writeFileSync(statePath, successor!);
          request.socket.destroy();
        },
        (port) =>
          Effect.gen(function* () {
            yield* persistPrimaryDescriptor(baseDir, { port, pid: process.pid });
            successor = NodeFS.readFileSync(statePath);
            yield* persistPrimaryDescriptor(baseDir, { port, pid: DEAD_PID });

            const { exit, output } = yield* addNextWorkspace(baseDir, workspaceRoot);

            assertFailedWith(exit, "ProjectLiveServerUnavailableError");
            assert.notInclude(output, "Added project");
            assert.deepEqual(NodeFS.readFileSync(statePath), successor);
            assert.deepEqual(
              (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
              [project.id],
            );
          }),
      );
    }),
  );

  it.effect(
    "registers through a live primary, which then holds the new and existing projects",
    () =>
      Effect.gen(function* () {
        const { baseDir, workspaceRoot } = yield* makeProjectLookupFixture();
        const before = yield* readProjects(baseDir);
        const primary = makeFakePrimary(before);
        yield* withPrimaryServer(primary.handler, (port) =>
          Effect.gen(function* () {
            const descriptor = yield* persistPrimaryDescriptor(baseDir, {
              port,
              pid: process.pid,
            });

            const { exit, output, nextWorkspace } = yield* addNextWorkspace(baseDir, workspaceRoot);

            assert.isTrue(Exit.isSuccess(exit));
            assert.lengthOf(primary.mutations, 1);
            const mutation = primary.mutations[0]!;
            assert.equal(mutation.type, "project.create");
            assert.include(output, `Added project ${mutation.projectId} `);
            assert.match(output, /\. Mode: live\.$/);

            const after = yield* readPrimarySnapshot(port);
            const identities = (snapshot: ProjectSnapshot) =>
              snapshot.projects.map(({ id, title, workspaceRoot }) => ({
                id,
                title,
                workspaceRoot,
              }));
            // Every project the primary held keeps its identity, and exactly the
            // requested workspace was added under the id the CLI reported.
            assert.deepEqual(
              identities(after).slice(0, before.projects.length),
              identities(before),
            );
            assert.lengthOf(after.projects, before.projects.length + 1);
            const added = after.projects.at(-1)!;
            assert.equal(added.id, mutation.projectId);
            assert.equal(added.workspaceRoot, nextWorkspace);
            assert.notInclude(
              before.projects.map((entry) => entry.id),
              added.id,
            );

            assert.deepEqual(NodeFS.readFileSync(descriptor.statePath), descriptor.bytes);
            // The primary owns the write; the CLI must not also write offline.
            assert.deepEqual(yield* readProjects(baseDir), before);
          }),
        );
      }),
  );

  it.effect.each([
    { response: "drop after commit" as const },
    { response: "stall after commit" as const },
  ])(
    "reports an unknown live outcome when the primary commits and the response is lost ($response)",
    ({ response }) =>
      Effect.gen(function* () {
        const { baseDir, workspaceRoot } = yield* makeProjectLookupFixture();
        const before = yield* readProjects(baseDir);
        const primary = makeFakePrimary(before, response);
        yield* withPrimaryServer(primary.handler, (port) =>
          Effect.gen(function* () {
            const descriptor = yield* persistPrimaryDescriptor(baseDir, {
              port,
              pid: process.pid,
            });

            const { exit, output, nextWorkspace } = yield* addNextWorkspace(baseDir, workspaceRoot);

            const error = assertFailedWith(exit, "ProjectLiveMutationOutcomeUnknownError");
            const mutation = primary.mutations[0]!;
            assert.include(error.message, mutation.projectId);
            assert.include(error.message, "may already have applied it");
            assert.include(error.message, "Nothing was written offline");
            assert.notInclude(output, "Added project");

            // The primary did commit: reporting a plain failure would be wrong.
            const after = yield* readPrimarySnapshot(port);
            assert.include(
              after.projects.map((entry) => entry.workspaceRoot),
              nextWorkspace,
            );
            assert.deepEqual(NodeFS.readFileSync(descriptor.statePath), descriptor.bytes);
            assert.deepEqual(yield* readProjects(baseDir), before);
          }),
        );
      }),
  );

  it.effect("reports offline registration when no primary is recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-offline-" });
      const workspaceRoot = NodePath.join(root, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      const baseDir = NodePath.join(root, "state");

      const { exit, output } = yield* runCliCapturingOutput([
        "project",
        "add",
        workspaceRoot,
        "--base-dir",
        baseDir,
      ]);

      assert.isTrue(Exit.isSuccess(exit));
      assert.match(output, /Added project \S+ \(workspace\) at \S+\. Mode: offline\./);
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.workspaceRoot),
        [workspaceRoot],
      );
    }),
  );
});
