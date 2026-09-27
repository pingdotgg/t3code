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
  DelegationAuditError,
  EnvironmentRpcAuthorization,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  ORCHESTRATION_WS_METHODS,
  WsOrchestrationAppendDelegationAuditEventRpc,
  WsOrchestrationBeginDelegationAuditRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetDelegationAuditPageRpc,
  WsOrchestrationGetShellSnapshotRpc,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { cli, __testing } from "./cli.ts";
import { withLiveRpcClient } from "./cli/client.ts";
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
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { authWebSocketTokenRouteLayer, respondToAuthError } from "./auth/http.ts";
import { rpcAuthorizationLayer } from "./auth/RpcAuthorization.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { DelegationAuditRepository } from "./persistence/Services/DelegationAudit.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { dispatchThroughStartupGate } from "./orchestration/gatedDispatch.ts";
import { deriveDelegationCleanupIntents } from "./orchestration/delegationAuditCleanup.ts";

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
const withCliTestRpcClient = <A, E, R>(
  baseDir: string,
  run: Parameters<typeof withLiveRpcClient<A, E, R>>[1],
) =>
  withLiveRpcClient(
    {
      url: Option.none(),
      token: Option.none(),
      baseDir: Option.some(baseDir),
      environment: Option.none(),
    },
    run,
  ).pipe(Effect.provide(CliRuntimeLayerLive));

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

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isDelegationAuditError = Schema.is(DelegationAuditError);
const mapDelegationAuditError = (cause: unknown): DelegationAuditError =>
  isDelegationAuditError(cause)
    ? cause
    : new DelegationAuditError({
        code: "audit-persistence-unavailable",
        message: "Delegation audit persistence is unavailable.",
        cause,
      });

const CliTestRpcGroup = RpcGroup.make(
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetShellSnapshotRpc,
  WsOrchestrationBeginDelegationAuditRpc,
  WsOrchestrationAppendDelegationAuditEventRpc,
  WsOrchestrationGetDelegationAuditPageRpc,
).middleware(EnvironmentRpcAuthorization);

const cliTestRpcHandlersLayer = (options: { readonly loseTurnStartReply?: boolean } = {}) =>
  CliTestRpcGroup.toLayer(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const audit = yield* DelegationAuditRepository;
      const startup = yield* ServerRuntimeStartup;

      return CliTestRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          normalizeDispatchCommand(command).pipe(
            Effect.flatMap((normalized) =>
              dispatchThroughStartupGate(normalized, engine, startup).pipe(
                Effect.flatMap((result) =>
                  options.loseTurnStartReply && normalized.type === "thread.turn.start"
                    ? Effect.fail(
                        new OrchestrationDispatchCommandError({
                          message: "Dispatch response was lost after command commit.",
                          cause: new Error("simulated response loss after commit"),
                        }),
                      )
                    : Effect.succeed(result),
                ),
              ),
            ),
            Effect.mapError((cause) =>
              isOrchestrationDispatchCommandError(cause)
                ? cause
                : new OrchestrationDispatchCommandError({
                    message: "Failed to dispatch orchestration command.",
                    cause,
                  }),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.getShellSnapshot]: () =>
          snapshots.getShellSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load orchestration shell snapshot.",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.beginDelegationAudit]: (input) =>
          Effect.gen(function* () {
            const readModel = yield* engine.getReadModel();
            const thread = readModel.threads.find(
              (candidate) => candidate.id === input.sourceThreadId && candidate.deletedAt === null,
            );
            if (thread === undefined) {
              return yield* new DelegationAuditError({
                code: "source-thread-not-found",
                message: "The source thread is not available for delegation audit.",
              });
            }
            const sourceTurnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
            const sourceMessageId = thread.session?.activeMessageId ?? null;
            const initiatingMessageId =
              sourceMessageId ??
              thread.messages
                .toReversed()
                .find(
                  (message) =>
                    message.role === "user" &&
                    sourceTurnId !== null &&
                    message.turnId === sourceTurnId,
                )?.id ??
              null;
            const project = yield* snapshots.getProjectShellById(thread.projectId);
            return yield* audit.begin({
              ...input,
              sourceTurnId,
              sourceMessageId,
              initiatingMessageId,
              providerInstanceId: thread.modelSelection.instanceId,
              model: thread.modelSelection.model,
              workspaceRoot:
                thread.worktreePath ??
                (Option.isSome(project) ? project.value.workspaceRoot : null),
              buildRevision: "cli-test-server",
              occurredAt: new Date().toISOString(),
            });
          }).pipe(Effect.mapError(mapDelegationAuditError)),
        [ORCHESTRATION_WS_METHODS.appendDelegationAuditEvent]: (input) =>
          Effect.gen(function* () {
            const source = yield* snapshots.getThreadShellById(input.sourceThreadId);
            if (Option.isNone(source)) {
              return yield* new DelegationAuditError({
                code: "source-thread-not-found",
                message: "The source thread is not available for delegation audit.",
              });
            }
            const operationSource = yield* audit.getOperationSource(input.operationId);
            if (Option.isNone(operationSource) || operationSource.value !== input.sourceThreadId) {
              return yield* new DelegationAuditError({
                code: "operation-not-found",
                message: "The delegation audit operation was not found for this source thread.",
              });
            }
            yield* audit.append({ ...input, occurredAt: new Date().toISOString() });
          }).pipe(Effect.mapError(mapDelegationAuditError)),
        [ORCHESTRATION_WS_METHODS.getDelegationAuditPage]: (input) =>
          Effect.gen(function* () {
            const operationSource =
              input.operationId === undefined
                ? Option.none()
                : yield* audit.getOperationSource(input.operationId);
            const sourceThreadId = input.sourceThreadId ?? Option.getOrNull(operationSource);
            if (sourceThreadId === null) {
              return yield* new DelegationAuditError({
                code: "operation-not-found",
                message: "The delegation audit operation was not found.",
              });
            }
            const source = yield* snapshots.getThreadShellById(sourceThreadId);
            if (Option.isNone(source)) {
              return yield* new DelegationAuditError({
                code: "source-thread-not-found",
                message: "The source thread is not available for delegation audit.",
              });
            }
            if (Option.isSome(operationSource) && operationSource.value !== sourceThreadId) {
              return yield* new DelegationAuditError({
                code: "operation-not-found",
                message: "The delegation audit operation was not found for this source thread.",
              });
            }
            const page = yield* audit.page({ ...input, sourceThreadId });
            const cleanupStates = deriveDelegationCleanupIntents(page.events)
              .filter((attempt) => attempt.cleanupRequested !== null)
              .map((attempt) => ({
                ...attempt,
                jobId: null,
                status: attempt.cleanupRequested
                  ? ("pending-enqueue" as const)
                  : ("not-required" as const),
                attemptCount: null,
                nextAttemptAt: null,
                reason: null,
                error: null,
              }));
            const warnings = [
              ...page.warnings,
              ...cleanupStates
                .filter((state) => state.status === "pending-enqueue")
                .map(
                  (state) =>
                    `Cleanup state for attempt ${state.attemptId} is unresolved; reconciliation is required.`,
                ),
            ];
            return { ...page, cleanupStates, warnings };
          }).pipe(
            Effect.mapError((cause) =>
              isDelegationAuditError(cause)
                ? cause
                : new DelegationAuditError({
                    code: "audit-persistence-unavailable",
                    message: "Unable to load the delegation audit page.",
                    cause,
                  }),
            ),
          ),
      });
    }),
  );

type CliTestRpcHandlersLayer = ReturnType<typeof cliTestRpcHandlersLayer>;

const cliTestWebSocketRouteLayer = (handlersLayer: CliTestRpcHandlersLayer) =>
  HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const serverAuth = yield* ServerAuth;
      const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
      const rpcHttpEffect = yield* RpcServer.toHttpEffectWebsocket(CliTestRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            handlersLayer,
            RpcSerialization.layerJson,
            rpcAuthorizationLayer(new Set(session.scopes), session.role),
          ),
        ),
      );
      return yield* rpcHttpEffect;
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  );

const withLiveProjectCliServer = <A, E, R>(
  baseDir: string,
  run: () => Effect.Effect<A, E, R>,
  options: { readonly loseTurnStartReply?: boolean } = {},
) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = Layer.mergeAll(
      authWebSocketTokenRouteLayer,
      cliTestWebSocketRouteLayer(cliTestRpcHandlersLayer(options)),
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
  it.effect("normalizes optional delegation audit filters and source thread IDs", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(__testing.delegationAuditReadFilters(Option.none(), Option.none()), {
        beforeSequence: null,
      });
      assert.deepStrictEqual(
        __testing.delegationAuditReadFilters(
          Option.some("turn-1"),
          Option.some(12),
          Option.some("provider-call"),
        ),
        {
          turnId: TurnId.make("turn-1"),
          toolCallId: "provider-call",
          beforeSequence: 12,
        },
      );
      assert.equal(__testing.delegationAuditSourceThreadId(Option.none()), null);
      assert.equal(
        __testing.delegationAuditSourceThreadId(Option.some("source-thread")),
        ThreadId.make("source-thread"),
      );
    }),
  );

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

          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("source-session-end-active-turn"),
            threadId: sourceThreadId,
            createdAt: new Date().toISOString(),
            session: {
              threadId: sourceThreadId,
              status: "stopped",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: new Date().toISOString(),
            },
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("source-session-start-without-message"),
            threadId: sourceThreadId,
            createdAt: new Date().toISOString(),
            session: {
              threadId: sourceThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: TurnId.make("source-turn-without-message"),
              lastError: null,
              updatedAt: new Date().toISOString(),
            },
          });
          const rejectedCreation = yield* captureExitAndStdout(
            runCli([
              "chat",
              "new",
              "--project",
              workspaceRoot,
              "--parent",
              created.threadId,
              "--cross-thread-source",
              sourceThreadId,
              "--cross-thread-capability",
              issueCrossThreadDispatchCapability(sourceThreadId),
              "--title",
              "Missing Active Message Child",
              "rejected-first-turn",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.equal(rejectedCreation.exit._tag, "Failure");
          const rejectedOutcome = JSON.parse(rejectedCreation.output) as {
            readonly status: string;
            readonly threadId: string | null;
            readonly errorCode: string | null;
            readonly cleanupPerformed: boolean;
          };
          assert.equal(rejectedOutcome.status, "failed", rejectedCreation.output);
          assert.equal(rejectedOutcome.errorCode, "TURN_START_REJECTED");
          assert.isTrue(rejectedOutcome.cleanupPerformed);
          const rejectedThreadId = rejectedOutcome.threadId;
          if (rejectedThreadId === null) {
            return assert.fail("Expected the rejected child thread id to remain in the outcome.");
          }
          const deletedRejectedChild = (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === ThreadId.make(rejectedThreadId),
          );
          assert.isNotNull(deletedRejectedChild?.deletedAt);

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

  it.effect("preserves a child after its committed first-turn RPC reply is lost", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-lost-turn-reply-test-"));
      const workspaceRoot = makeGitWorkspace("t3-cli-lost-turn-reply-workspace-");

      yield* withLiveProjectCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            yield* runCliWithRuntime([
              "project",
              "add",
              workspaceRoot,
              "--title",
              "Lost Reply Project",
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
                "Lost Reply Parent",
                "--base-dir",
                baseDir,
              ]),
            );
            const parent = JSON.parse(parentOutput.output) as { readonly threadId: string };
            const childAttempt = yield* captureExitAndStdout(
              runCli([
                "chat",
                "new",
                "--project",
                workspaceRoot,
                "--parent",
                parent.threadId,
                "--title",
                "Committed Turn Child",
                "first turn committed before reply loss",
                "--base-dir",
                baseDir,
              ]),
            );

            assert.equal(childAttempt.exit._tag, "Failure");
            const outcome = JSON.parse(childAttempt.output) as {
              readonly status: string;
              readonly threadId: string | null;
              readonly cleanupPerformed: boolean;
              readonly errorCode: string | null;
            };
            assert.deepStrictEqual(
              {
                status: outcome.status,
                cleanupPerformed: outcome.cleanupPerformed,
                errorCode: outcome.errorCode,
              },
              {
                status: "ambiguous",
                cleanupPerformed: false,
                errorCode: "TURN_START_AMBIGUOUS",
              },
            );
            const childThreadIdValue = outcome.threadId;
            if (childThreadIdValue === null) {
              throw new Error("Expected the committed child id to remain in the outcome.");
            }
            const childThreadId = ThreadId.make(childThreadIdValue);
            const engine = yield* OrchestrationEngineService;
            const child = (yield* engine.getReadModel()).threads.find(
              (thread) => thread.id === childThreadId,
            );
            assert.isDefined(child);
            assert.isNull(child.deletedAt);
            assert.isTrue(
              child.messages.some(
                (message) => message.text === "first turn committed before reply loss",
              ),
            );
          }),
        { loseTurnStartReply: true },
      );
    }),
  );

  it.effect("reconstructs five rejected delegation attempts after a CLI server restart", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "t3-cli-audit-restart-test-"));
    const workspaceRoot = makeGitWorkspace("t3-cli-audit-restart-workspace-");
    return Effect.gen(function* () {
      const scenario = yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Audit Acceptance Project",
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
          const parentOutput = yield* captureStdout(
            runCli([
              "chat",
              "create",
              "--project",
              workspaceRoot,
              "--title",
              "Five Rejection Source",
              "--base-dir",
              baseDir,
            ]),
          );
          const sourceThreadId = ThreadId.make(
            (JSON.parse(parentOutput.output) as { readonly threadId: string }).threadId,
          );
          yield* runCliWithRuntime([
            "chat",
            "send",
            sourceThreadId,
            "Request five delegated children.",
            "--base-dir",
            baseDir,
          ]);

          const engine = yield* OrchestrationEngineService;
          const source = (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === sourceThreadId,
          );
          const sourceMessage = source?.messages.findLast((message) => message.role === "user");
          if (!sourceMessage) {
            throw new Error("Expected a persisted source message.");
          }
          const sourceTurnId = TurnId.make(`audit-source-turn:${crypto.randomUUID()}`);

          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`audit-source-active-message:${crypto.randomUUID()}`),
            threadId: sourceThreadId,
            createdAt: new Date().toISOString(),
            session: {
              threadId: sourceThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: sourceTurnId,
              activeMessageId: sourceMessage.id,
              lastError: null,
              updatedAt: new Date().toISOString(),
            },
          });
          const activeSource = (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === sourceThreadId,
          );
          assert.equal(activeSource?.session?.activeTurnId, sourceTurnId);
          assert.equal(activeSource?.session?.activeMessageId, sourceMessage.id);

          const operationId = `audit-five-rejections-${crypto.randomUUID()}`;
          const toolCallId = `provider-call-${crypto.randomUUID()}`;
          const attemptIds = Array.from({ length: 5 }, () => crypto.randomUUID());
          const requests = attemptIds.map((attemptId, index) => ({
            attemptId,
            arguments: {
              title: `Rejected child ${String(index + 1)}`,
              prompt:
                `Use config {"password":"synthetic-password-value-${String(index + 1)}"} ` +
                `and run curl -H "Cookie: session=synthetic-cookie-value-${String(index + 1)}" example.invalid`,
            },
          }));
          const begin = yield* withCliTestRpcClient(baseDir, (rpc) =>
            rpc[ORCHESTRATION_WS_METHODS.beginDelegationAudit]({
              operationId,
              sourceThreadId,
              toolCallId,
              toolName: "delegate_work",
              toolVersion: "acceptance-fixture/1",
              providerInstanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
              workspaceRoot,
              gitRevision: null,
              buildRevision: "acceptance-fixture",
              requests,
              occurredAt: new Date().toISOString(),
            }),
          );
          if (begin.initiatingMessageId === null) {
            throw new Error(
              `Expected the audit request to retain its initiating message id: ${JSON.stringify({
                begin,
                activeSession: activeSource?.session,
              })}`,
            );
          }
          assert.equal(begin.sourceTurnId, sourceTurnId);
          assert.equal(begin.initiatingMessageId, sourceMessage.id);

          yield* Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`audit-source-stop:${crypto.randomUUID()}`),
              threadId: sourceThreadId,
              createdAt: new Date().toISOString(),
              session: {
                threadId: sourceThreadId,
                status: "stopped",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: new Date().toISOString(),
              },
            });
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`audit-source-clear-message:${crypto.randomUUID()}`),
              threadId: sourceThreadId,
              createdAt: new Date().toISOString(),
              session: {
                threadId: sourceThreadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: sourceTurnId,
                lastError: null,
                updatedAt: new Date().toISOString(),
              },
            });
          });

          const children: Array<{ readonly attemptId: string; readonly threadId: ThreadId }> = [];
          for (const [index, attemptId] of attemptIds.entries()) {
            const creation = yield* captureExitAndStdout(
              runCli([
                "chat",
                "new",
                "--project",
                workspaceRoot,
                "--parent",
                sourceThreadId,
                "--cross-thread-source",
                sourceThreadId,
                "--cross-thread-capability",
                issueCrossThreadDispatchCapability(sourceThreadId),
                "--audit-operation-id",
                operationId,
                "--audit-attempt-id",
                attemptId,
                "--audit-initiating-message-id",
                begin.initiatingMessageId,
                "--thread-id",
                crypto.randomUUID(),
                "--assignment-id",
                crypto.randomUUID(),
                "--title",
                `Rejected child ${String(index + 1)}`,
                `Child prompt ${String(index + 1)}`,
                "--base-dir",
                baseDir,
              ]),
            );
            assert.equal(creation.exit._tag, "Failure", creation.output);
            const outcome = JSON.parse(creation.output) as {
              readonly status: string;
              readonly threadId: string | null;
              readonly errorCode: string | null;
              readonly cleanupPerformed: boolean;
            };
            assert.deepStrictEqual(
              {
                status: outcome.status,
                errorCode: outcome.errorCode,
                cleanupPerformed: outcome.cleanupPerformed,
              },
              {
                status: "failed",
                errorCode: "TURN_START_REJECTED",
                cleanupPerformed: true,
              },
            );
            if (outcome.threadId === null) {
              throw new Error(`Attempt ${attemptId} did not retain its child thread id.`);
            }
            const childThreadId = ThreadId.make(outcome.threadId);
            const child = (yield* engine.getReadModel()).threads.find(
              (thread) => thread.id === childThreadId,
            );
            assert.isNotNull(child?.deletedAt);
            children.push({ attemptId, threadId: childThreadId });

            yield* withCliTestRpcClient(baseDir, (rpc) =>
              rpc[ORCHESTRATION_WS_METHODS.appendDelegationAuditEvent]({
                eventId: EventId.make(`acceptance-attempt-completed:${crypto.randomUUID()}`),
                operationId,
                sourceThreadId,
                attemptId,
                eventType: "attempt.completed",
                childThreadId,
                payload: {
                  toolTransport: "completed",
                  operationStatus: outcome.status,
                  retryable: true,
                  errorCode: outcome.errorCode,
                  workspaceCreated: false,
                },
                occurredAt: new Date().toISOString(),
              }),
            );
          }

          yield* withCliTestRpcClient(baseDir, (rpc) =>
            rpc[ORCHESTRATION_WS_METHODS.appendDelegationAuditEvent]({
              eventId: EventId.make(`acceptance-operation-failed:${crypto.randomUUID()}`),
              operationId,
              sourceThreadId,
              attemptId: null,
              eventType: "operation.failed",
              childThreadId: null,
              payload: {
                toolTransport: "completed",
                operationStatus: "failed",
                attemptCount: 5,
                completedAttemptCount: 0,
                failedAttemptCount: 5,
                unresolvedAttemptIds: [],
              },
              occurredAt: new Date().toISOString(),
            }),
          );

          const sourceState = (yield* engine.getReadModel()).threads.find(
            (thread) => thread.id === sourceThreadId,
          )?.session;
          assert.equal(sourceState?.activeTurnId, sourceTurnId);
          assert.isUndefined(sourceState?.activeMessageId);
          return {
            sourceThreadId,
            sourceTurnId,
            initiatingMessageId: begin.initiatingMessageId,
            operationId,
            toolCallId,
            children,
          };
        }),
      );

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          const pages: Array<{
            readonly events: ReadonlyArray<{
              readonly eventId: string;
              readonly sequence: number;
              readonly attemptId: string | null;
              readonly childThreadId: ThreadId | null;
              readonly eventType: string;
              readonly evidenceStatus: string;
              readonly redacted: boolean;
              readonly context: {
                readonly authorization: {
                  readonly sourceThreadId: ThreadId;
                  readonly sourceTurnId: TurnId | null;
                  readonly initiatingMessageId: MessageId | null;
                  readonly scope: string;
                };
                readonly toolCallId: string;
                readonly buildRevision: string;
                readonly gitRevision: string | null;
              };
              readonly payload: unknown;
            }>;
            readonly cleanupStates: ReadonlyArray<{
              readonly attemptId: string;
              readonly childThreadId: ThreadId;
              readonly status: string;
            }>;
            readonly hasMore: boolean;
            readonly nextBeforeSequence: number | null;
            readonly warnings: ReadonlyArray<string>;
          }> = [];
          let beforeSequence: number | null = null;
          do {
            const pageArgs = [
              "chat",
              "audit",
              scenario.sourceThreadId,
              "--turn",
              scenario.sourceTurnId,
              "--tool-call",
              scenario.toolCallId,
              "--limit",
              "4",
              ...(beforeSequence === null ? [] : ["--before-sequence", String(beforeSequence)]),
              "--base-dir",
              baseDir,
            ];
            const pageOutput = yield* captureStdout(runCli(pageArgs));
            const page = JSON.parse(pageOutput.output) as (typeof pages)[number];
            pages.push(page);
            beforeSequence = page.nextBeforeSequence;
          } while (pages.at(-1)?.hasMore);

          assert.isAbove(pages.length, 1);
          const listedEvents = pages.flatMap((page) => page.events);
          const listedIds = listedEvents.map((event) => event.eventId);
          assert.equal(new Set(listedIds).size, listedIds.length);
          assert.isTrue(
            pages.every((page) =>
              page.events.every(
                (event) =>
                  event.context.authorization.sourceThreadId === scenario.sourceThreadId &&
                  event.context.authorization.sourceTurnId === scenario.sourceTurnId &&
                  event.context.authorization.initiatingMessageId !== null &&
                  event.context.authorization.scope === "orchestration:operate" &&
                  event.context.toolCallId === scenario.toolCallId &&
                  event.context.buildRevision === "cli-test-server" &&
                  event.context.gitRevision === null,
              ),
            ),
          );

          const operationEvents = listedEvents.filter(
            (event) => event.context.toolCallId === scenario.toolCallId,
          );
          const countType = (eventType: string) =>
            operationEvents.filter((event) => event.eventType === eventType).length;
          assert.equal(countType("attempt.requested"), 5);
          assert.equal(countType("turn.start.rejected"), 5);
          assert.equal(countType("thread.deletion.accepted"), 5);
          assert.equal(countType("attempt.completed"), 5);
          assert.equal(countType("operation.failed"), 1);

          const rejectionEvents = operationEvents.filter(
            (event) => event.eventType === "turn.start.rejected",
          );
          for (const rejection of rejectionEvents) {
            const payload = rejection.payload as {
              readonly code: string;
              readonly expectedInitiatingMessageId: string;
              readonly actualActiveTurnId: string;
              readonly actualActiveMessageId: string | null;
              readonly evidenceState: string;
              readonly orchestrationSequence: number;
              readonly precedingSessionTransition: unknown;
              readonly messagePreviouslyPresentTransition: unknown;
            };
            assert.equal(payload.code, "MISSING_ACTIVE_MESSAGE");
            assert.equal(payload.expectedInitiatingMessageId, scenario.initiatingMessageId);
            assert.equal(payload.actualActiveTurnId, scenario.sourceTurnId);
            assert.isNull(payload.actualActiveMessageId);
            assert.equal(payload.evidenceState, "cleared-by-later-update");
            assert.isAbove(payload.orchestrationSequence, 0);
            assert.isNotNull(payload.precedingSessionTransition);
            assert.isNotNull(payload.messagePreviouslyPresentTransition);
            assert.isNotNull(rejection.childThreadId);
          }

          const requestedEvents = operationEvents.filter(
            (event) => event.eventType === "attempt.requested",
          );
          assert.isTrue(
            requestedEvents.every(
              (event) =>
                event.redacted &&
                event.evidenceStatus === "redacted" &&
                !JSON.stringify(event.payload).includes("synthetic-password-value") &&
                !JSON.stringify(event.payload).includes("synthetic-cookie-value"),
            ),
          );

          const listedCleanup = pages.flatMap((page) => page.cleanupStates);
          const cleanupByAttempt = new Map<string, (typeof listedCleanup)[number]>();
          for (const cleanup of listedCleanup) {
            const previous = cleanupByAttempt.get(cleanup.attemptId);
            if (previous !== undefined) {
              assert.deepStrictEqual(previous, cleanup);
            }
            cleanupByAttempt.set(cleanup.attemptId, cleanup);
          }
          assert.equal(cleanupByAttempt.size, 5);
          assert.isTrue(
            [...cleanupByAttempt.values()].every(
              (cleanup) =>
                cleanup.status === "not-required" &&
                scenario.children.some(
                  (child) =>
                    child.attemptId === cleanup.attemptId &&
                    child.threadId === cleanup.childThreadId,
                ),
            ),
          );
          const pageWarnings = pages.flatMap((page) => page.warnings);
          assert.isTrue(
            pageWarnings.some((warning) =>
              warning.includes("missing execution context: Git revision"),
            ),
          );
          assert.isTrue(
            pageWarnings.every(
              (warning) =>
                !warning.includes("require reconciliation") && !warning.includes("unresolved"),
            ),
          );

          const showOutput = yield* captureStdout(
            runCli(["audit", "show", scenario.operationId, "--limit", "4", "--base-dir", baseDir]),
          );
          const showPage = JSON.parse(showOutput.output) as (typeof pages)[number];
          assert.isTrue(showPage.hasMore);
          assert.isNotNull(showPage.nextBeforeSequence);
          const nextShowOutput = yield* captureStdout(
            runCli([
              "audit",
              "show",
              scenario.operationId,
              "--limit",
              "4",
              "--before-sequence",
              String(showPage.nextBeforeSequence),
              "--base-dir",
              baseDir,
            ]),
          );
          const nextShowPage = JSON.parse(nextShowOutput.output) as (typeof pages)[number];
          assert.isTrue(
            showPage.events.every(
              (event) => !nextShowPage.events.some((next) => next.eventId === event.eventId),
            ),
          );

          const exportOutput = yield* captureStdout(
            runCli(["audit", "export", scenario.sourceThreadId, "--base-dir", baseDir]),
          );
          const exported = JSON.parse(exportOutput.output) as {
            readonly sourceThreadId: ThreadId;
            readonly buildContext: ReadonlyArray<{
              readonly buildRevision: string;
              readonly gitRevision: string | null;
            }>;
            readonly events: ReadonlyArray<{
              readonly eventId: string;
              readonly childThreadId: ThreadId | null;
              readonly payload: unknown;
            }>;
            readonly cleanupStates: ReadonlyArray<{
              readonly attemptId: string;
              readonly childThreadId: ThreadId;
              readonly status: string;
            }>;
            readonly warnings: ReadonlyArray<string>;
          };
          assert.equal(exported.sourceThreadId, scenario.sourceThreadId);
          assert.equal(exported.events.length, listedEvents.length);
          assert.deepStrictEqual(
            exported.events.map((event) => event.eventId).toSorted(),
            listedIds.toSorted(),
          );
          assert.isTrue(
            exported.buildContext.some(
              (context) =>
                context.buildRevision === "cli-test-server" && context.gitRevision === null,
            ),
          );
          assert.equal(exported.cleanupStates.length, 5);
          assert.isTrue(
            exported.cleanupStates.every((cleanup) => cleanup.status === "not-required"),
          );
          assert.isTrue(
            exported.warnings.some((warning) =>
              warning.includes("missing execution context: Git revision"),
            ),
          );
          assert.isTrue(
            !JSON.stringify(exported).includes("synthetic-password-value") &&
              !JSON.stringify(exported).includes("synthetic-cookie-value"),
          );
          assert.isTrue(
            scenario.children.every((child) =>
              exported.events.some((event) => event.childThreadId === child.threadId),
            ),
          );

          const sourceAuthorizedPage = yield* withCliTestRpcClient(baseDir, (rpc) =>
            rpc[ORCHESTRATION_WS_METHODS.getDelegationAuditPage]({
              operationId: scenario.operationId,
              sourceThreadId: scenario.sourceThreadId,
              beforeSequence: null,
              limit: 4,
            }),
          );
          assert.isTrue(sourceAuthorizedPage.events.length > 0);
          const childAccess = yield* withCliTestRpcClient(baseDir, (rpc) =>
            Effect.exit(
              rpc[ORCHESTRATION_WS_METHODS.getDelegationAuditPage]({
                operationId: scenario.operationId,
                sourceThreadId: scenario.children[0]!.threadId,
                beforeSequence: null,
                limit: 4,
              }),
            ),
          );
          assert.equal(childAccess._tag, "Failure");
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(baseDir, { recursive: true, force: true });
          rmSync(workspaceRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

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
