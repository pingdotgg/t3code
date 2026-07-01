import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "./cli.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "./config.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
} from "./orchestration/http.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
    } satisfies ServerConfigShape;
  });

const makeProjectPersistenceLayer = (config: ServerConfigShape) =>
  Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolverLive),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    WorkspacePathsLive,
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerConfig, config)),
  );

const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      return yield* projectionSnapshotQuery.getSnapshot();
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = Layer.mergeAll(
      orchestrationSnapshotRouteLayer,
      orchestrationDispatchRouteLayer,
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        ServerAuthLive.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStoreLive),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provide(
        Layer.mock(GitCore)({
          createWorktree: () => Effect.die("unexpected createWorktree call in CLI live test"),
          resolveReviewChangesContext: () =>
            Effect.succeed({
              scope: "uncommitted" as const,
              branch: null,
              statusShort: " M file.ts",
              untrackedFiles: [],
              hasReviewableChanges: true,
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(GitStatusBroadcaster)({
          refreshStatus: () => Effect.die("unexpected refreshStatus call in CLI live test"),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          enqueueCommand: (effect) => effect,
        }),
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(ServerConfig, config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected TCP address, got ${address}`);
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: makePersistedServerRuntimeState({
            config,
            port: address.port,
          }),
        });
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

it.layer(NodeServices.layer)("cli log-level parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    runCliWithRuntime(["--log-level", "debug", "--version"]),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    runCliWithRuntime(["--no-log-websocket-events", "--version"]),
  );

  it.effect("exposes review command scope flags", () =>
    Effect.gen(function* () {
      const output = yield* captureStdout(runCli(["review", "--help"]));

      assert.include(output.output, "Create a new review chat for local code changes.");
      assert.include(output.output, "--scope choice");
      assert.include(output.output, "uncommitted");
      assert.include(output.output, "against-base");
    }),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["--log-level", "Debug"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("executes auth pairing subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-auth-pairing-test-"));

      const createdOutput = yield* captureStdout(
        runCli(["auth", "pairing", "create", "--base-dir", baseDir, "--json"]),
      );
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string;
        readonly credential: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
      );
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly id: string;
        readonly credential?: string;
      }>;

      assert.equal(typeof created.id, "string");
      assert.equal(typeof created.credential, "string");
      assert.equal(created.credential.length > 0, true);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
      assert.equal("credential" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("executes auth session subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-auth-session-test-"));

      const issuedOutput = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string;
        readonly token: string;
        readonly role: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
      );
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string;
        readonly token?: string;
        readonly role: string;
      }>;

      assert.equal(typeof issued.sessionId, "string");
      assert.equal(typeof issued.token, "string");
      assert.equal(issued.role, "owner");
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.equal(listed[0]?.role, "owner");
      assert.equal("token" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("rejects invalid ttl values before running auth commands", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["auth", "pairing", "create", "--ttl", "soon"]).pipe(
        Effect.flip,
      );

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "auth", "pairing", "create"]);
      const ttlError = error.errors[0] as CliError.CliError | undefined;
      if (!ttlError || ttlError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(ttlError?._tag)}`);
      }
      assert.equal(ttlError.option, "ttl");
      assert.equal(ttlError.value, "soon");
      assert.isTrue(ttlError.message.includes("Invalid duration"));
      assert.isTrue(ttlError.message.includes("5m, 1h, 30d, or 15 minutes"));
    }),
  );

  it.effect("adds, renames, and removes projects offline through the orchestration engine", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-projects-offline-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-projects-workspace-"));

      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Alpha",
        "--base-dir",
        baseDir,
      ]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const addedProject = afterAdd.projects.find(
        (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
      );
      assert.isTrue(addedProject !== undefined);
      assert.equal(addedProject?.title, "Alpha");

      yield* runCliWithRuntime(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
      const afterRename = yield* readPersistedSnapshot(baseDir);
      const renamedProject = afterRename.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.equal(renamedProject?.title, "Beta");
      assert.equal(renamedProject?.deletedAt, null);

      yield* runCliWithRuntime([
        "project",
        "remove",
        addedProject?.id ?? "",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      const removedProject = afterRemove.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.isTrue((removedProject?.deletedAt ?? null) !== null);
    }),
  );

  it.effect("routes project commands through a running server when runtime state is present", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-projects-live-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-projects-live-workspace-"));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Live Project",
            "--base-dir",
            baseDir,
          ]);
          const orchestrationEngine = yield* OrchestrationEngineService;
          const readModel = yield* orchestrationEngine.getReadModel();
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          );
          assert.isTrue(addedProject !== undefined);
          assert.equal(addedProject?.title, "Live Project");
        }),
      );
    }),
  );

  it.effect("prints orchestration snapshots from a running server", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-orchestration-snapshot-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-orchestration-snapshot-workspace-"));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Snapshot Project",
            "--base-dir",
            baseDir,
          ]);

          const snapshotOutput = yield* captureStdout(
            runCli(["orchestration", "snapshot", "--base-dir", baseDir]),
          );
          const snapshot = JSON.parse(snapshotOutput.output) as {
            readonly projects: ReadonlyArray<{
              readonly title: string;
              readonly workspaceRoot: string;
              readonly deletedAt: string | null;
            }>;
          };
          const project = snapshot.projects.find(
            (candidate) => candidate.workspaceRoot === workspaceRoot,
          );

          assert.equal(project?.title, "Snapshot Project");
          assert.equal(project?.deletedAt, null);
        }),
      );
    }),
  );

  it.effect("lists and shows projects from a running server", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-project-list-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-project-list-workspace-"));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Listable Project",
            "--base-dir",
            baseDir,
          ]);

          const listOutput = yield* captureStdout(
            runCli(["project", "list", "--base-dir", baseDir]),
          );
          const list = JSON.parse(listOutput.output) as ReadonlyArray<{
            readonly title: string;
            readonly workspaceRoot: string;
          }>;
          assert.isTrue(
            list.some(
              (project) =>
                project.title === "Listable Project" && project.workspaceRoot === workspaceRoot,
            ),
          );

          const showOutput = yield* captureStdout(
            runCli(["project", "show", workspaceRoot, "--base-dir", baseDir]),
          );
          const shown = JSON.parse(showOutput.output) as {
            readonly title: string;
            readonly workspaceRoot: string;
          };
          assert.equal(shown.title, "Listable Project");
          assert.equal(shown.workspaceRoot, workspaceRoot);
        }),
      );
    }),
  );

  it.effect("updates project default model and scripts offline", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-project-meta-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-project-meta-workspace-"));

      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Meta Project",
        "--base-dir",
        baseDir,
      ]);
      yield* runCliWithRuntime([
        "project",
        "set-default-model",
        workspaceRoot,
        "--payload",
        '{"instanceId":"codex","model":"gpt-5.4"}',
        "--base-dir",
        baseDir,
      ]);
      yield* runCliWithRuntime([
        "project",
        "set-scripts",
        workspaceRoot,
        "--payload",
        '[{"id":"test","name":"Test","command":"bun run test","icon":"test","runOnWorktreeCreate":false}]',
        "--base-dir",
        baseDir,
      ]);

      const snapshot = yield* readPersistedSnapshot(baseDir);
      const project = snapshot.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot,
      );
      assert.equal(project?.defaultModelSelection?.instanceId, "codex");
      assert.equal(project?.defaultModelSelection?.model, "gpt-5.4");
      assert.equal(project?.scripts[0]?.id, "test");
      assert.equal(project?.scripts[0]?.command, "bun run test");
    }),
  );

  it.effect("lists and shows chats from a running server", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-chat-list-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-chat-list-workspace-"));
      const now = new Date().toISOString();

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Chat Project",
            "--base-dir",
            baseDir,
          ]);
          const orchestrationEngine = yield* OrchestrationEngineService;
          const readModel = yield* orchestrationEngine.getReadModel();
          const project = readModel.projects.find(
            (candidate) => candidate.workspaceRoot === workspaceRoot,
          );
          if (project === undefined) {
            assert.fail("Expected project to be created.");
          }
          const threadId = ThreadId.make("cli-chat-list-thread");
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cli-chat-list-thread-create"),
            threadId,
            projectId: project.id,
            title: "CLI Chat",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          });

          const listOutput = yield* captureStdout(runCli(["chat", "list", "--base-dir", baseDir]));
          const list = JSON.parse(listOutput.output) as ReadonlyArray<{ readonly title: string }>;
          assert.isTrue(list.some((thread) => thread.title === "CLI Chat"));

          const showOutput = yield* captureStdout(
            runCli(["chat", "show", "CLI Chat", "--base-dir", baseDir]),
          );
          const shown = JSON.parse(showOutput.output) as { readonly title: string };
          assert.equal(shown.title, "CLI Chat");
        }),
      );
    }),
  );

  it.effect("manages chat lifecycle metadata from the CLI", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-chat-lifecycle-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-chat-lifecycle-workspace-"));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Lifecycle Project",
            "--base-dir",
            baseDir,
          ]);

          const createdOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Lifecycle Chat",
              "--model",
              "gpt-5.4",
              "--provider",
              "codex",
              "--base-dir",
              baseDir,
            ]),
          );
          const created = JSON.parse(createdOutput.output) as { readonly threadId: string };

          yield* runCliWithRuntime([
            "chat",
            "rename",
            created.threadId,
            "Renamed Chat",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "chat",
            "set-model",
            created.threadId,
            "--provider",
            "codex",
            "--model",
            "gpt-5.3-codex",
            "--reasoning",
            "high",
            "--fast-mode",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "chat",
            "set-runtime",
            created.threadId,
            "--runtime-mode",
            "auto-accept-edits",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "chat",
            "set-interaction",
            created.threadId,
            "--interaction-mode",
            "plan",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "chat",
            "set-branch",
            created.threadId,
            "--branch",
            "feature/cli",
            "--worktree",
            "/tmp/t3-cli-worktree",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime(["chat", "archive", created.threadId, "--base-dir", baseDir]);
          yield* runCliWithRuntime(["chat", "unarchive", created.threadId, "--base-dir", baseDir]);

          const orchestrationEngine = yield* OrchestrationEngineService;
          const readModel = yield* orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((candidate) => candidate.id === created.threadId);

          assert.equal(thread?.title, "Renamed Chat");
          assert.equal(thread?.modelSelection.model, "gpt-5.3-codex");
          assert.equal(thread?.runtimeMode, "auto-accept-edits");
          assert.equal(thread?.interactionMode, "plan");
          assert.equal(thread?.branch, "feature/cli");
          assert.equal(thread?.worktreePath, "/tmp/t3-cli-worktree");
          assert.equal(thread?.archivedAt, null);

          yield* runCliWithRuntime(["chat", "delete", created.threadId, "--base-dir", baseDir]);
          const afterDelete = yield* orchestrationEngine.getReadModel();
          const deletedThread = afterDelete.threads.find(
            (candidate) => candidate.id === created.threadId,
          );
          assert.isTrue((deletedThread?.deletedAt ?? null) !== null);
        }),
      );
    }),
  );

  it.effect("sends turns and manages queued turns from the CLI", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-chat-turn-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-chat-turn-workspace-"));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Turn Project",
            "--base-dir",
            baseDir,
          ]);
          const newChatOutput = yield* captureStdout(
            runCli([
              "chat",
              "new",
              "--project",
              workspaceRoot,
              "--title",
              "New Turn Chat",
              "first-prompt",
              "--base-dir",
              baseDir,
            ]),
          );
          const newChat = JSON.parse(newChatOutput.output) as { readonly threadId: string };

          const createdOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Turn Chat",
              "--base-dir",
              baseDir,
            ]),
          );
          const created = JSON.parse(createdOutput.output) as { readonly threadId: string };

          yield* runCliWithRuntime([
            "chat",
            "send",
            created.threadId,
            "hello-agent",
            "--base-dir",
            baseDir,
          ]);

          const queuedOutput = yield* captureStdout(
            runCli([
              "chat",
              "queue",
              "add",
              created.threadId,
              "queued-prompt",
              "--base-dir",
              baseDir,
            ]),
          );
          const queued = JSON.parse(queuedOutput.output) as { readonly queuedTurnId: string };
          yield* runCliWithRuntime([
            "chat",
            "queue",
            "update",
            created.threadId,
            queued.queuedTurnId,
            "updated-queued-prompt",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "chat",
            "queue",
            "delete",
            created.threadId,
            queued.queuedTurnId,
            "--base-dir",
            baseDir,
          ]);

          const dispatchChatOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Dispatch Queue Chat",
              "--base-dir",
              baseDir,
            ]),
          );
          const dispatchChat = JSON.parse(dispatchChatOutput.output) as {
            readonly threadId: string;
          };
          const dispatchQueuedOutput = yield* captureStdout(
            runCli([
              "chat",
              "queue",
              "add",
              dispatchChat.threadId,
              "dispatch-queued-prompt",
              "--base-dir",
              baseDir,
            ]),
          );
          const dispatchQueued = JSON.parse(dispatchQueuedOutput.output) as {
            readonly queuedTurnId: string;
          };
          yield* runCliWithRuntime([
            "chat",
            "queue",
            "dispatch",
            dispatchChat.threadId,
            dispatchQueued.queuedTurnId,
            "--base-dir",
            baseDir,
          ]);

          const orchestrationEngine = yield* OrchestrationEngineService;
          const readModel = yield* orchestrationEngine.getReadModel();
          const sentThread = readModel.threads.find(
            (candidate) => candidate.id === created.threadId,
          );
          const newThread = readModel.threads.find(
            (candidate) => candidate.id === newChat.threadId,
          );
          const dispatchedThread = readModel.threads.find(
            (candidate) => candidate.id === dispatchChat.threadId,
          );

          assert.equal(newThread?.title, "New Turn Chat");
          assert.equal(newThread?.modelSelection.instanceId, "codex");
          assert.equal(newThread?.modelSelection.model, "gpt-5.4");
          assert.equal(newThread?.modelSelection.options, undefined);
          assert.isTrue(newThread?.messages.some((message) => message.text === "first-prompt"));
          assert.equal(sentThread?.modelSelection.instanceId, "codex");
          assert.equal(sentThread?.modelSelection.model, "gpt-5.4");
          assert.equal(sentThread?.modelSelection.options, undefined);
          assert.isTrue(sentThread?.messages.some((message) => message.text === "hello-agent"));
          assert.equal(sentThread?.queuedTurns?.length ?? 0, 0);
          assert.isTrue(
            dispatchedThread?.messages.some((message) => message.text === "dispatch-queued-prompt"),
          );
        }),
      );
    }),
  );

  it.effect("lists and responds to approval and user-input requests from the CLI", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-requests-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "t3-cli-requests-workspace-"));
      const now = new Date().toISOString();

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Requests Project",
            "--base-dir",
            baseDir,
          ]);

          const createdOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Requests Chat",
              "--base-dir",
              baseDir,
            ]),
          );
          const created = JSON.parse(createdOutput.output) as { readonly threadId: string };
          const orchestrationEngine = yield* OrchestrationEngineService;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cli-approval-activity"),
            threadId: ThreadId.make(created.threadId),
            activity: {
              id: EventId.make("cli-approval-activity-event"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval requested",
              payload: {
                requestId: ApprovalRequestId.make("approval-request-cli"),
                requestKind: "command",
                requestType: "command_execution_approval",
              },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cli-input-activity"),
            threadId: ThreadId.make(created.threadId),
            activity: {
              id: EventId.make("cli-input-activity-event"),
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              payload: {
                requestId: ApprovalRequestId.make("user-input-request-cli"),
                questions: [{ id: "mode", label: "Mode" }],
              },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          });

          const approvalListOutput = yield* captureStdout(
            runCli(["approval", "list", "--thread", created.threadId, "--base-dir", baseDir]),
          );
          const approvals = JSON.parse(approvalListOutput.output) as ReadonlyArray<{
            readonly requestId: string;
          }>;
          assert.equal(approvals[0]?.requestId, "approval-request-cli");

          const inputListOutput = yield* captureStdout(
            runCli(["input", "list", "--thread", created.threadId, "--base-dir", baseDir]),
          );
          const inputs = JSON.parse(inputListOutput.output) as ReadonlyArray<{
            readonly requestId: string;
          }>;
          assert.equal(inputs[0]?.requestId, "user-input-request-cli");

          yield* runCliWithRuntime([
            "approval",
            "respond",
            created.threadId,
            "approval-request-cli",
            "--approve",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "input",
            "respond",
            created.threadId,
            "user-input-request-cli",
            "--answers",
            '{"mode":"fast"}',
            "--base-dir",
            baseDir,
          ]);

          const readModel = yield* orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((candidate) => candidate.id === created.threadId);
          assert.isTrue(
            thread?.activities.some((activity) => activity.kind === "approval.requested") ?? false,
          );
        }),
      );
    }),
  );

  it.effect("manages local CLI environment profiles", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-env-test-"));

      yield* runCliWithRuntime([
        "env",
        "add",
        "local",
        "--url",
        "http://127.0.0.1:3333",
        "--token",
        "secret-token",
        "--label",
        "Local Server",
        "--use",
        "--base-dir",
        baseDir,
      ]);
      yield* runCliWithRuntime([
        "env",
        "secret",
        "set",
        "local",
        "API_KEY",
        "super-secret",
        "--base-dir",
        baseDir,
      ]);

      const listOutput = yield* captureStdout(runCli(["env", "list", "--base-dir", baseDir]));
      const list = JSON.parse(listOutput.output) as {
        readonly current: string;
        readonly environments: Record<
          string,
          { readonly token?: string; readonly secrets?: Record<string, string> }
        >;
      };
      assert.equal(list.current, "local");
      assert.equal(list.environments.local?.token, "<redacted>");
      assert.equal(list.environments.local?.secrets?.API_KEY, "<redacted>");

      yield* runCliWithRuntime(["env", "rename", "local", "Renamed Local", "--base-dir", baseDir]);
      yield* runCliWithRuntime([
        "env",
        "secret",
        "remove",
        "local",
        "API_KEY",
        "--base-dir",
        baseDir,
      ]);
      yield* runCliWithRuntime(["env", "remove", "local", "--base-dir", baseDir]);

      const afterRemoveOutput = yield* captureStdout(
        runCli(["env", "list", "--base-dir", baseDir]),
      );
      const afterRemove = JSON.parse(afterRemoveOutput.output) as {
        readonly environments: Record<string, unknown>;
      };
      assert.deepEqual(afterRemove.environments, {});
    }),
  );

  it.effect("rejects high-risk CLI operations without confirmation before connecting", () =>
    Effect.gen(function* () {
      const checkpointError = yield* runCliWithRuntime([
        "checkpoint",
        "revert",
        "missing-thread",
        "--turn-count",
        "1",
      ]).pipe(Effect.flip);
      assert.equal(String(checkpointError).includes("Re-run with --yes to confirm"), true);

      const providerRemoveError = yield* runCliWithRuntime([
        "provider",
        "instance",
        "remove",
        "codex",
      ]).pipe(Effect.flip);
      assert.equal(String(providerRemoveError).includes("Re-run with --yes to confirm"), true);

      const terminalDeleteHistoryError = yield* runCliWithRuntime([
        "terminal",
        "close",
        "missing-thread",
        "--delete-history",
      ]).pipe(Effect.flip);
      assert.equal(
        String(terminalDeleteHistoryError).includes("Re-run with --yes to confirm"),
        true,
      );

      const sigkillError = yield* runCliWithRuntime(["diagnostics", "signal", "1", "SIGKILL"]).pipe(
        Effect.flip,
      );
      assert.equal(String(sigkillError).includes("Re-run with --yes to confirm"), true);
    }),
  );

  it.effect("validates keybinding rules before connecting", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["keybinding", "add", "mod+x", "not-a-command"]).pipe(
        Effect.flip,
      );

      assert.equal(String(error).includes("Invalid keybinding rule"), true);
    }),
  );

  it.effect("rejects invalid raw orchestration dispatch payloads before connecting", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["orchestration", "dispatch", "--payload", "{}"]).pipe(
        Effect.flip,
      );

      assert.equal(
        String(error).includes("Payload is not a valid client orchestration command"),
        true,
      );
    }),
  );

  it.effect("rejects dev-url on project commands", () =>
    Effect.gen(function* () {
      const workspaceRoot = mkdtempSync(
        join(tmpdir(), "t3-cli-projects-unknown-option-workspace-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--dev-url",
        "http://127.0.0.1:5173",
      ]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "project", "add"]);
      const optionError = error.errors[0] as CliError.CliError | undefined;
      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }
      assert.equal(optionError.option, "--dev-url");
    }),
  );
});
