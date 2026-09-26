import * as NodeHttp from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "./cli.ts";
import { CliRuntimeLayerLive } from "./cliRuntime.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "./config.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationShellSnapshotRouteLayer,
  orchestrationSnapshotRouteLayer,
  orchestrationThreadSnapshotRouteLayer,
  orchestrationThreadReadRouteLayer,
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

const makeGitWorkspace = (prefix: string) => {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", workspace, "commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return workspace;
};
import { runProcess } from "./processRunner.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { issueCrossThreadDispatchCapability } from "./orchestration/CrossThreadDispatchCapability.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayerLive));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayerLive, TestConsole.layer)));

const captureExitAndStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { exit, output };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayerLive, TestConsole.layer)));

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

const reviewChangesContext = {
  scope: "uncommitted" as const,
  branch: null,
  statusShort: " M file.ts",
  untrackedFiles: [],
  hasReviewableChanges: true,
};

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = Layer.mergeAll(
      orchestrationSnapshotRouteLayer,
      orchestrationShellSnapshotRouteLayer,
      orchestrationThreadSnapshotRouteLayer,
      orchestrationThreadReadRouteLayer,
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
          resolveReviewChangesContext: () => Effect.succeed(reviewChangesContext),
          claimReviewChangesContext: () => Effect.succeed(reviewChangesContext),
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

  it.effect("rejects conflicting chat history views and full-view pagination before reading", () =>
    Effect.gen(function* () {
      for (const flags of [
        ["--messages", "--activities"],
        ["--full", "--messages"],
        ["--full", "--activities"],
        ["--full", "--limit", "1"],
        ["--full", "--before", "cursor"],
      ]) {
        const error = yield* runCliWithRuntime([
          "chat",
          "show",
          "unused",
          "--url",
          "http://127.0.0.1:1",
          "--token",
          "unused",
          ...flags,
        ]).pipe(Effect.flip);
        assert.deepInclude(error, {
          _tag: "CliPayloadError",
          message:
            "Choose --messages, --activities, or --full; pagination cannot be used with --full.",
        });
      }
    }),
  );

  it.effect("keeps invalid-argument help on stderr and requested help on stdout", () =>
    Effect.gen(function* () {
      const entrypoint = fileURLToPath(new URL("./bin.ts", import.meta.url));
      const failure = yield* Effect.promise(() =>
        runProcess(process.execPath, [entrypoint, "chat", "show", "unused", "--invalid-cli-flag"], {
          allowNonZeroExit: true,
        }),
      );
      assert.notEqual(failure.code, 0);
      assert.equal(failure.stdout, "");
      assert.include(failure.stderr, "USAGE");
      const error = JSON.parse(failure.stderr.trim().split("\n").at(-1)!);
      assert.equal(error.error.code, "CLI_INVALID_ARGUMENT");
      assert.include(error.error.message, "--invalid-cli-flag");
      for (const args of [["chat"], ["chat", "show", "--help"]]) {
        const help = yield* Effect.promise(() =>
          runProcess(process.execPath, [entrypoint, ...args], { allowNonZeroExit: true }),
        );
        assert.equal(help.code, 0, help.stderr);
        assert.include(help.stdout, "USAGE");
        assert.equal(help.stderr, "");
      }
    }),
  );

  it.effect("runs Connect status without parsing an invalid server port", () => {
    const baseDir = mkdtempSync(join(process.cwd(), ".connect-cli-invalid-port-"));
    return captureStdout(
      runCli(["connect", "status", "--json", "--base-dir", baseDir]).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { T3CODE_PORT: "not-a-port" },
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.tap(({ output }) =>
        Effect.sync(() => {
          const parsed: unknown = JSON.parse(output);
          assert.deepInclude(parsed, { state: "logged-out" });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(baseDir, { recursive: true, force: true });
        }),
      ),
    );
  });

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
      const workspaceRoot = makeGitWorkspace("t3-cli-projects-workspace-");

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
      const workspaceRoot = makeGitWorkspace("t3-cli-projects-live-workspace-");

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
      const workspaceRoot = makeGitWorkspace("t3-cli-orchestration-snapshot-workspace-");

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
      const workspaceRoot = makeGitWorkspace("t3-cli-project-list-workspace-");

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
      const workspaceRoot = makeGitWorkspace("t3-cli-project-meta-workspace-");

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
      const workspaceRoot = makeGitWorkspace("t3-cli-chat-list-workspace-");
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

  it.effect("prunes only requested child assignments from the current wait", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-wait-prune-test-"));
      const workspaceRoot = makeGitWorkspace("t3-cli-wait-prune-workspace-");
      const now = new Date().toISOString();

      try {
        yield* withLiveProjectCliServer(baseDir, () =>
          Effect.gen(function* () {
            yield* runCliWithRuntime([
              "project",
              "add",
              workspaceRoot,
              "--title",
              "Wait Prune Project",
              "--base-dir",
              baseDir,
            ]);
            const engine = yield* OrchestrationEngineService;
            const readModel = yield* engine.getReadModel();
            const project = readModel.projects.find(
              (candidate) => candidate.workspaceRoot === workspaceRoot,
            );
            if (project === undefined) {
              assert.fail("Expected project to be created.");
            }

            const parentThreadId = ThreadId.make("cli-wait-prune-parent");
            const failedChildThreadId = ThreadId.make("cli-wait-prune-failed-child");
            const remainingChildThreadId = ThreadId.make("cli-wait-prune-remaining-child");
            const failedAssignmentId = MessageId.make("cli-wait-prune-failed-assignment");
            const remainingAssignmentId = MessageId.make("cli-wait-prune-remaining-assignment");
            for (const [threadId, assignmentId] of [
              [parentThreadId, undefined],
              [failedChildThreadId, failedAssignmentId],
              [remainingChildThreadId, remainingAssignmentId],
            ] as const) {
              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`create-${threadId}`),
                threadId,
                projectId: project.id,
                title: threadId,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: now,
                ...(assignmentId
                  ? {
                      parentThreadId,
                      delegation: {
                        assignmentId,
                        followUp: "automatic" as const,
                        completedAt: null,
                      },
                    }
                  : {}),
              });
            }
            yield* engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make("set-wait-prune-parent-wait"),
              threadId: parentThreadId,
              childWait: {
                mode: "any",
                assignments: [
                  { childThreadId: failedChildThreadId, assignmentId: failedAssignmentId },
                  { childThreadId: remainingChildThreadId, assignmentId: remainingAssignmentId },
                ],
              },
            });

            yield* runCliWithRuntime([
              "chat",
              "wait-prune",
              parentThreadId,
              JSON.stringify([
                {
                  childThreadId: failedChildThreadId,
                  assignmentId: failedAssignmentId,
                },
              ]),
              "--base-dir",
              baseDir,
            ]);

            const updated = yield* engine.getReadModel();
            const parent = updated.threads.find((thread) => thread.id === parentThreadId);
            assert.deepEqual(parent?.nudging?.wait, {
              mode: "any",
              generationId: CommandId.make("set-wait-prune-parent-wait"),
              assignments: [
                { childThreadId: remainingChildThreadId, assignmentId: remainingAssignmentId },
              ],
            });
          }),
        );
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("manages chat lifecycle metadata from the CLI", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-chat-lifecycle-test-"));
      const workspaceRoot = makeGitWorkspace("t3-cli-chat-lifecycle-workspace-");
      const handoffWorktree = join(tmpdir(), `t3-cli-worktree-${process.pid}`);

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
          const created = JSON.parse(createdOutput.output) as {
            readonly threadId: string;
            readonly threadUrl: string;
          };
          assert.equal(new URL(created.threadUrl).pathname.split("/").at(-1), created.threadId);

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
            "handoff",
            created.threadId,
            "--branch",
            "feature/cli",
            "--worktree",
            handoffWorktree,
            "--continue-prompt",
            "Continue in the worktree",
            "--command-id",
            "cmd-cli-workspace-handoff",
            "--base-dir",
            baseDir,
          ]);
          yield* runCliWithRuntime([
            "chat",
            "handoff",
            created.threadId,
            "--branch",
            "feature/should-not-apply",
            "--worktree",
            "/tmp/should-not-apply",
            "--continue-prompt",
            "Should not be queued",
            "--command-id",
            "cmd-cli-workspace-handoff",
            "--base-dir",
            baseDir,
          ]);
          const secondCreatedOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Second Lifecycle Chat",
              "--model",
              "gpt-5.4",
              "--provider",
              "codex",
              "--base-dir",
              baseDir,
            ]),
          );
          const secondCreated = JSON.parse(secondCreatedOutput.output) as {
            readonly threadId: string;
          };
          const duplicateWorktreeError = yield* runCliWithRuntime([
            "chat",
            "handoff",
            secondCreated.threadId,
            "--branch",
            "feature/cli",
            "--worktree",
            handoffWorktree,
            "--continue-prompt",
            "Continue in the existing worktree",
            "--base-dir",
            baseDir,
          ]).pipe(Effect.flip);
          assert.equal(
            String(duplicateWorktreeError).includes("ORCHESTRATION_COMMAND_REJECTED:"),
            true,
          );
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
          assert.equal(thread?.worktreePath, handoffWorktree);
          assert.equal(thread?.queuedTurns?.[0]?.message.text, "Continue in the worktree");
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
      const workspaceRoot = makeGitWorkspace("t3-cli-chat-turn-workspace-");

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
          yield* runCliWithRuntime([
            "project",
            "set-default-model",
            workspaceRoot,
            "--payload",
            '{"instanceId":"codex","model":"gpt-5.4"}',
            "--base-dir",
            baseDir,
          ]);
          const orchestrationEngine = yield* OrchestrationEngineService;
          const configuredProject = (yield* orchestrationEngine.getReadModel()).projects.find(
            (project) => project.workspaceRoot === workspaceRoot,
          );
          assert.deepStrictEqual(configuredProject?.defaultModelSelection, {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          });
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
            "create",
            "--project",
            workspaceRoot,
            "--title",
            "Unrelated Chat",
            "--base-dir",
            baseDir,
          ]);

          const newChatOutput = yield* captureStdout(
            runCli([
              "chat",
              "new",
              "--project",
              workspaceRoot,
              "--parent",
              created.threadId,
              "--title",
              "New Turn Chat",
              "first-prompt",
              "--base-dir",
              baseDir,
            ]),
          );
          const newChat = JSON.parse(newChatOutput.output) as {
            readonly threadId: string;
            readonly threadUrl: string;
          };
          assert.equal(new URL(newChat.threadUrl).pathname.split("/").at(-1), newChat.threadId);

          const invalidNew = yield* captureExitAndStdout(
            runCli([
              "chat",
              "new",
              "--project",
              "missing-project",
              "--parent",
              created.threadId,
              "invalid-prompt",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.equal(invalidNew.exit._tag, "Failure");
          assert.deepStrictEqual(JSON.parse(invalidNew.output), {
            status: "failed",
            threadId: null,
            threadUrl: null,
            retryable: false,
            workspaceCreated: false,
            cleanupPerformed: false,
            errorCode: "VALIDATION_FAILED",
            message: "No active project found for 'missing-project'.",
          });

          const dryRun = yield* captureStdout(
            runCli([
              "chat",
              "new",
              "--project",
              workspaceRoot,
              "--parent",
              created.threadId,
              "--follow-up",
              "automatic",
              "--dry-run",
              "dry-run-prompt",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.deepStrictEqual(JSON.parse(dryRun.output), {
            status: "dry-run",
            threadId: null,
            threadUrl: null,
            retryable: false,
            workspaceCreated: false,
            cleanupPerformed: false,
            errorCode: null,
            message: "Nested-thread inputs are valid; no thread or workspace was created.",
          });

          const orphanedFollowUp = yield* captureExitAndStdout(
            runCli([
              "chat",
              "new",
              "--project",
              workspaceRoot,
              "--follow-up",
              "automatic",
              "--dry-run",
              "invalid-follow-up",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.equal(orphanedFollowUp.exit._tag, "Failure");
          assert.equal(
            JSON.parse(orphanedFollowUp.output).message,
            "--follow-up requires --parent",
          );

          const allChatsOutput = yield* captureStdout(
            runCli(["chat", "list", "--base-dir", baseDir]),
          );
          const allChats = JSON.parse(allChatsOutput.output) as ReadonlyArray<{
            readonly title: string;
          }>;
          assert.isTrue(allChats.some((thread) => thread.title === "Turn Chat"));
          assert.isTrue(allChats.some((thread) => thread.title === "Unrelated Chat"));

          const childListOutput = yield* captureStdout(
            runCli(["chat", "list", "--parent", created.threadId, "--base-dir", baseDir]),
          );
          const childList = JSON.parse(childListOutput.output) as ReadonlyArray<{
            readonly id: string;
            readonly parentThreadId: string | null;
          }>;
          assert.equal(childList.length, 1);
          assert.equal(childList[0]?.id, newChat.threadId);
          assert.equal(childList[0]?.parentThreadId, created.threadId);

          const childShowOutput = yield* captureStdout(
            runCli(["chat", "show", newChat.threadId, "--base-dir", baseDir]),
          );
          const shownChild = JSON.parse(childShowOutput.output) as {
            readonly parentThreadId: string | null;
          };
          assert.equal(shownChild.parentThreadId, created.threadId);

          yield* runCliWithRuntime([
            "chat",
            "send",
            created.threadId,
            "hello-agent",
            "--base-dir",
            baseDir,
          ]);

          const engine = yield* OrchestrationEngineService;
          const sourceThreadId = ThreadId.make(created.threadId);
          const sourceThread = (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === sourceThreadId,
          );
          const sourceMessage = sourceThread?.messages.findLast(
            (message) => message.role === "user",
          );
          if (!sourceMessage) return assert.fail("Expected the source turn's user message.");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("source-session"),
            threadId: sourceThreadId,
            createdAt: new Date().toISOString(),
            session: {
              threadId: sourceThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: TurnId.make("source-turn"),
              activeMessageId: sourceMessage.id,
              lastError: null,
              updatedAt: new Date().toISOString(),
            },
          });
          const capability = issueCrossThreadDispatchCapability(sourceThreadId);
          const crossThreadArgs = [
            "chat",
            "queue",
            "add",
            newChat.threadId,
            "cross-thread-prompt",
            "--cross-thread-source",
            sourceThreadId,
            "--base-dir",
            baseDir,
          ];
          const crossThreadOutput = yield* captureStdout(
            runCli([...crossThreadArgs, "--cross-thread-capability", capability]),
          );
          const crossThreadQueued = JSON.parse(crossThreadOutput.output) as {
            readonly queuedTurnId: string;
          };
          for (const invalidCapability of [
            undefined,
            "invalid",
            capability,
            issueCrossThreadDispatchCapability(ThreadId.make(newChat.threadId)),
          ]) {
            const rejected = yield* Effect.exit(
              runCliWithRuntime([
                ...crossThreadArgs,
                ...(invalidCapability === undefined
                  ? []
                  : ["--cross-thread-capability", invalidCapability]),
              ]),
            );
            assert.equal(rejected._tag, "Failure");
          }
          const queuedChild = (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === newChat.threadId,
          );
          assert.equal(queuedChild?.queuedTurns?.length, 1);
          assert.deepStrictEqual(queuedChild?.queuedTurns?.[0]?.origin, {
            kind: "cross-thread",
            sourceThreadId,
            sourceMessageId: sourceMessage.id,
            sourceThreadTitle: "Turn Chat",
          });
          assert.equal(queuedChild?.queuedTurns?.[0]?.id, crossThreadQueued.queuedTurnId);
          assert.isFalse(
            queuedChild?.messages.some((message) => message.text === "cross-thread-prompt"),
          );

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
          assert.equal(newThread?.parentThreadId, created.threadId);
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
      const restored = yield* readPersistedSnapshot(baseDir);
      const restoredChild = restored.threads.find((thread) => thread.title === "New Turn Chat");
      assert.equal(restoredChild?.queuedTurns?.length, 1);
      assert.equal(restoredChild?.queuedTurns?.[0]?.message.text, "cross-thread-prompt");
      assert.equal(restoredChild?.queuedTurns?.[0]?.origin?.kind, "cross-thread");
      const restoredSource = restored.threads.find((thread) => thread.title === "Turn Chat");
      const restoredSourceMessage = restoredSource?.messages.findLast(
        (message) => message.role === "user",
      );
      if (!restoredSource || !restoredSourceMessage) {
        return assert.fail("Expected the persisted source thread and message.");
      }
      assert.deepStrictEqual(restoredChild?.queuedTurns?.[0]?.origin, {
        kind: "cross-thread",
        sourceThreadId: restoredSource.id,
        sourceMessageId: restoredSourceMessage.id,
        sourceThreadTitle: "Turn Chat",
      });
    }),
  );

  it.effect("resolves workspace paths through the production CLI entrypoint", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-production-runtime-test-"));
      const workspaceRoot = makeGitWorkspace("t3-cli-production-runtime-workspace-");

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Production Runtime Project",
            "--base-dir",
            baseDir,
          ]);
          const parentOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Production Runtime Parent",
              "--base-dir",
              baseDir,
            ]),
          );
          const parent = JSON.parse(parentOutput.output) as { readonly threadId: string };
          const result = yield* Effect.promise(() =>
            runProcess(
              process.execPath,
              [
                fileURLToPath(new URL("./bin.ts", import.meta.url)),
                "chat",
                "new",
                "--project",
                workspaceRoot,
                "--parent",
                parent.threadId,
                "--dry-run",
                "production-runtime-probe",
                "--base-dir",
                baseDir,
              ],
              {
                cwd: process.cwd(),
                allowNonZeroExit: true,
              },
            ),
          );

          assert.equal(result.code, 0, result.stderr);
          assert.include(result.stderr, "Running all migrations");
          assert.deepStrictEqual(JSON.parse(result.stdout), {
            status: "dry-run",
            threadId: null,
            threadUrl: null,
            retryable: false,
            workspaceCreated: false,
            cleanupPerformed: false,
            errorCode: null,
            message: "Nested-thread inputs are valid; no thread or workspace was created.",
          });
          const history = yield* Effect.promise(() =>
            runProcess(
              process.execPath,
              [
                fileURLToPath(new URL("./bin.ts", import.meta.url)),
                "chat",
                "show",
                parent.threadId,
                "--messages",
                "--limit",
                "1",
                "--base-dir",
                baseDir,
              ],
              { allowNonZeroExit: true },
            ),
          );
          assert.equal(history.code, 0, history.stderr);
          const page = JSON.parse(history.stdout);
          assert.deepStrictEqual(page.messages, []);
          assert.deepStrictEqual(page.page, { hasMore: false, before: null });
          assert.notProperty(page, "checkpoints");
          assert.notProperty(page, "activities");
          const failure = yield* Effect.promise(() =>
            runProcess(
              process.execPath,
              [
                fileURLToPath(new URL("./bin.ts", import.meta.url)),
                "--log-level",
                "error",
                "chat",
                "show",
                "missing-thread",
                "--base-dir",
                baseDir,
              ],
              { allowNonZeroExit: true },
            ),
          );
          assert.notEqual(failure.code, 0);
          assert.equal(failure.stdout, "");
          assert.equal(JSON.parse(failure.stderr).error.code, "CliRpcError");
          assert.include(JSON.parse(failure.stderr).error.message, "was not found");
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(baseDir, { recursive: true, force: true });
            rmSync(workspaceRoot, { recursive: true, force: true });
          }),
        ),
      );
    }),
  );

  it.effect("lists and responds to approval and user-input requests from the CLI", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-requests-test-"));
      const workspaceRoot = makeGitWorkspace("t3-cli-requests-workspace-");
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

          for (let index = 0; index < 205; index++) {
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`cli-window-${index}`),
              threadId: ThreadId.make(created.threadId),
              activity: {
                id: EventId.make(`cli-window-${index}`),
                tone: "info",
                kind: "runtime.info",
                summary: "Later activity",
                payload: {},
                turnId: null,
                createdAt: new Date(Date.parse(now) + index + 1).toISOString(),
              },
              createdAt: now,
            });
          }

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
      yield* runCliWithRuntime([
        "env",
        "add",
        "account:prod",
        "--url",
        "https://manual-prod.example.test",
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
      assert.equal(list.environments["manual:local"]?.token, "<redacted>");
      assert.equal(list.environments["manual:local"]?.secrets?.API_KEY, "<redacted>");
      assert.property(list.environments, "manual:account:prod");

      yield* runCliWithRuntime(["env", "rename", "local", "Renamed Local", "--base-dir", baseDir]);
      yield* runCliWithRuntime(["env", "use", "manual:local", "--base-dir", baseDir]);
      yield* runCliWithRuntime(["env", "clear", "--base-dir", baseDir]);
      const clearedOutput = yield* captureStdout(runCli(["env", "list", "--base-dir", baseDir]));
      assert.isNull((JSON.parse(clearedOutput.output) as { readonly current: unknown }).current);
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
      yield* runCliWithRuntime(["env", "remove", "account:prod", "--base-dir", baseDir]);

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

  it.effect("rejects an unknown pr-monitor disposition before connecting", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime([
        "pr-monitor",
        "report",
        "chat-1",
        "fb_item_1",
        "maybe-later",
      ]).pipe(Effect.flip);

      assert.equal(String(error).includes("Invalid disposition"), true);
    }),
  );

  it.effect("rejects malformed pr-monitor findings before connecting", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime([
        "pr-monitor",
        "submit-findings",
        "chat-1",
        "acme/app",
        "12",
        "--findings",
        JSON.stringify([{ title: "no detail" }]),
      ]).pipe(Effect.flip);

      assert.equal(String(error).includes("Invalid findings"), true);
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
