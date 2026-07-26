// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  CommandId,
  EnvironmentId,
  EnvironmentHttpApi,
  EnvironmentAuthHttpApi,
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
  EventId,
  ORCHESTRATION_CLI_API_VERSION,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { FetchHttpClient } from "effect/unstable/http";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli, makeCli } from "./bin.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import { serverEnvironmentHttpApiLayer } from "./http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import {
  isOrchestrationCliInvocation,
  RemoteCliError,
  requireCliApiCompatibility,
} from "./cli/remote.ts";
import { RemoteWatchInteractionRequiredError } from "./cli/remoteWatch.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
class ProjectCliHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi) {}

const connectCli = makeCli({ cloudEnabled: true });
const noConnectCli = makeCli({ cloudEnabled: false });
const runCli = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: "0.0.0" })(args);
const runConnectCli = (args: ReadonlyArray<string>) => runCli(args, connectCli);
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
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
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
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const makeProjectPersistenceLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    WorkspacePaths.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provide(ServerConfig.layer(config)));

const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      return yield* projectionSnapshotQuery.getSnapshot();
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(authHttpApiLayer),
      Layer.provide(serverEnvironmentHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    );
    const environmentId = EnvironmentId.make("bin-test-local-environment");
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStore.layer),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Bin test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: {
              repositoryIdentity: true,
              orchestration: {
                pendingInteractions: true,
                cliApiVersion: ORCHESTRATION_CLI_API_VERSION,
                serverAuthoritativeCreate: true,
                watchResume: true,
              },
            },
          }),
        }),
      ),
      Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          close: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus: () => Effect.die("unexpected git status refresh"),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
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
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(ServerConfig.layer(config)),
        ),
      ),
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
          state: yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          }),
        });
        yield* Effect.promise(() =>
          NodeFS.promises.writeFile(config.environmentIdPath, `${environmentId}\n`),
        );
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

it.layer(NodeServices.layer)("bin cli parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    runCliWithRuntime(["--log-level", "debug", "--version"]),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    runCliWithRuntime(["--no-log-websocket-events", "--version"]),
  );

  it.effect("exposes the unified local orchestration command surface", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--help"]));
      for (const command of [
        "create",
        "send",
        "watch",
        "pending",
        "answer",
        "approve",
        "reject",
        "thread",
        "shell",
        "session",
        "snapshot",
      ]) {
        assert.include(output, command);
      }
      assert.include(output, "auth");
      assert.include(output, "remote");
    }),
  );

  it("routes failures only for actual top-level orchestration commands", () => {
    assert.isTrue(
      isOrchestrationCliInvocation(["--log-level", "debug", "--base-dir", "/tmp/t3", "session"]),
    );
    assert.isTrue(isOrchestrationCliInvocation(["remote", "watch", "thread-1"]));
    assert.isFalse(isOrchestrationCliInvocation(["auth", "pairing", "create"]));
    assert.isFalse(isOrchestrationCliInvocation(["project", "add", "/tmp/send"]));
    assert.isFalse(
      isOrchestrationCliInvocation(["--base-dir", "create", "auth", "session", "list"]),
    );
  });

  it.effect("fails local discovery without creating credentials when no server is live", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-local-missing-test-"),
      );
      const failure = yield* runCliWithRuntime(["session", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.equal(
        failure instanceof Error ? failure.message : "",
        "No live T3 server was discovered for this base directory.",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "local-cli")));
    }),
  );

  it.effect("rejects stale local runtime state before reading or creating credentials", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-local-stale-test-"),
      );
      const config = yield* makeCliTestServerConfig(baseDir);
      NodeFS.mkdirSync(NodePath.dirname(config.serverRuntimeStatePath), { recursive: true });
      NodeFS.writeFileSync(
        config.serverRuntimeStatePath,
        `${JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          host: "127.0.0.1",
          port: 65_534,
          origin: "http://127.0.0.1:65534",
          startedAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );

      const failure = yield* runCliWithRuntime(["session", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.equal(
        failure instanceof Error ? failure.message : "",
        "No live T3 server was discovered for this base directory.",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "local-cli")));
    }),
  );

  it.effect("reuses one minimum-scope local CLI principal across invocations", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-local-session-test-"),
      );
      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          const first = yield* captureStdout(runCli(["session", "--base-dir", baseDir]));
          const second = yield* captureStdout(runCli(["session", "--base-dir", baseDir]));
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI output DTO assertion.
          const firstDto = JSON.parse(first.output) as {
            readonly target: {
              readonly kind: string;
              readonly environment: { readonly environmentId: string };
            };
            readonly auth: {
              readonly scopes: ReadonlyArray<string>;
              readonly principal: { readonly sessionId: string; readonly subject: string };
            };
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI output DTO assertion.
          const secondDto = JSON.parse(second.output) as typeof firstDto;

          assert.equal(firstDto.target.kind, "local");
          assert.equal(firstDto.target.environment.environmentId, "bin-test-local-environment");
          assert.deepEqual(firstDto.auth.scopes, ["orchestration:read", "orchestration:operate"]);
          assert.equal(firstDto.auth.principal.sessionId, secondDto.auth.principal.sessionId);
          assert.equal(firstDto.auth.principal.subject, "local-cli:bin-test-local-environment");
        }),
      );
    }),
  );

  it.effect("interrupts a bare local watch when command approval is pending", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-local-watch-approval-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-local-watch-approval-workspace-"),
      );
      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const project = (yield* readPersistedSnapshot(baseDir)).projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot,
      );
      assert.isTrue(project !== undefined);

      const config = yield* makeCliTestServerConfig(baseDir);
      const threadId = ThreadId.make("thread-cli-watch-approval");
      const turnId = TurnId.make("turn-cli-watch-approval");
      const createdAt = "2026-07-25T00:00:00.000Z";
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-cli-watch-thread-create"),
          threadId,
          projectId: project!.id,
          title: "Approval watch",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: workspaceRoot,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-cli-watch-session-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-cli-watch-approval-requested"),
          threadId,
          activity: {
            id: EventId.make("activity-cli-watch-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "request-cli-watch-approval",
              requestKind: "command",
              command: "must-not-appear",
            },
            turnId,
            createdAt,
          },
          createdAt,
        });
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          const error = yield* runCli(["watch", threadId, "--base-dir", baseDir]).pipe(Effect.flip);
          assert.instanceOf(error, RemoteWatchInteractionRequiredError);
          assert.equal(error[Runtime.errorExitCode], 26);
          assert.equal(
            error.message,
            `{"threadId":"${threadId}","turnId":"${turnId}","interaction":{"kind":"approval","requestId":"request-cli-watch-approval","prompt":{"requestKind":"command"}}}`,
          );
          assert.notInclude(error.message, "must-not-appear");
        }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer))),
      );
    }),
  );

  it.effect("rejects orchestration CLI API version skew before authentication", () =>
    Effect.gen(function* () {
      const failure = yield* requireCliApiCompatibility(
        {
          environmentId: EnvironmentId.make("skewed"),
          label: "Skewed",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
            orchestration: {
              pendingInteractions: true,
              cliApiVersion: ORCHESTRATION_CLI_API_VERSION + 1,
              serverAuthoritativeCreate: true,
              watchResume: true,
            },
          },
        },
        "session",
      ).pipe(Effect.flip);

      assert.instanceOf(failure, RemoteCliError);
      assert.equal(failure.reason, "version-incompatible");
    }),
  );

  it.effect("rejects a live server whose environment id does not match the base directory", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-local-mismatch-test-"),
      );
      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(
            NodePath.join(baseDir, "userdata", "environment-id"),
            "different-environment\n",
          );
          const failure = yield* runCliWithRuntime(["session", "--base-dir", baseDir]).pipe(
            Effect.flip,
          );
          assert.equal(
            failure instanceof Error ? failure.message : "",
            "The discovered T3 server does not match this base directory.",
          );
          assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "local-cli")));
        }),
      );
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

  it.effect("rejects connect commands when public configuration is missing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["connect", "status"], noConnectCli).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "connect"]);
      assert.include(error.errors[0]?.message ?? "", "missing T3 Connect public configuration");

      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, "ERROR");
      assert.include(output, "missing T3 Connect public configuration");
    }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer))),
  );

  it.effect("exposes service lifecycle commands without T3 Connect configuration", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["service", "--help"], noConnectCli));

      assert.include(output, "Manage the T3 Code background service.");
      assert.include(output, "install");
      assert.include(output, "uninstall");
      assert.include(output, "update");
      assert.include(output, "status");
    }),
  );

  it.effect("reports fresh headless connect state without requiring local configuration", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const status = JSON.parse(output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
        readonly linked: boolean;
        readonly cloudUserId: string | null;
        readonly relayUrl: string | null;
      };

      assert.equal(status.desired, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.linked, false);
      assert.equal(status.cloudUserId, null);
      assert.equal(status.relayUrl, null);
    }),
  );

  it.effect("reports actionable human-readable headless connect state", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-human-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir]),
      );

      assert.include(output, "T3 Connect\n  Exposure: disabled");
      assert.include(output, "  Authorization: missing");
      assert.include(output, "  Environment link: not provisioned");
      assert.include(output, "Next: Run `t3 connect link` to authorize and enable T3 Connect.");
    }),
  );

  it.effect("accepts the --headless login override without enabling access", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-login-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(secretsDir, "cloud-cli-oauth-token.bin"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Test fixture matches the persisted CLI token representation.
        JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        }),
      );

      const login = yield* captureStdout(
        runConnectCli(["connect", "login", "--base-dir", baseDir, "--headless"]),
      );
      const status = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const decoded = JSON.parse(status.output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
      };

      assert.equal(login.output, "✓ Signed in");
      assert.isFalse(decoded.desired);
      assert.isTrue(decoded.authenticated);
    }),
  );

  it.effect("disables headless connect without a running server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-unlink-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "unlink", "--base-dir", baseDir]),
      );

      assert.equal(output, "T3 Connect is disabled locally.");
    }),
  );

  it.effect("logs out of headless connect and removes the stored CLI authorization", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-logout-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const tokenPath = NodePath.join(secretsDir, "cloud-cli-oauth-token.bin");
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(tokenPath, "invalid persisted token");

      const { output } = yield* captureStdout(
        runConnectCli(["connect", "logout", "--base-dir", baseDir]),
      );

      assert.equal(
        output,
        "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
      );
      assert.isFalse(NodeFS.existsSync(tokenPath));
    }),
  );

  it.effect("executes auth pairing subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-pairing-test-"),
      );

      const createdOutput = yield* captureStdout(
        runCli(["auth", "pairing", "create", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string;
        readonly credential: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
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
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-session-test-"),
      );

      const issuedOutput = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string;
        readonly token: string;
        readonly scopes: ReadonlyArray<string>;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string;
        readonly token?: string;
        readonly scopes: ReadonlyArray<string>;
      }>;

      assert.equal(typeof issued.sessionId, "string");
      assert.equal(typeof issued.token, "string");
      assert.deepEqual(issued.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.deepEqual(listed[0]?.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
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
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-offline-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-workspace-"),
      );

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

  it.effect("force removes projects that still contain threads", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-workspace-"),
      );

      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const project = afterAdd.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
      );
      assert.isTrue(project !== undefined);

      const config = yield* makeCliTestServerConfig(baseDir);
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-cli-force-remove-thread"),
          threadId: ThreadId.make("thread-cli-force-remove"),
          projectId: project!.id,
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));

      yield* runCliWithRuntime([
        "project",
        "remove",
        project!.id,
        "--force",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      assert.isTrue(
        (afterRemove.projects.find((candidate) => candidate.id === project!.id)?.deletedAt ??
          null) !== null,
      );
      assert.isTrue(
        (afterRemove.threads.find((thread) => thread.id === "thread-cli-force-remove")?.deletedAt ??
          null) !== null,
      );
    }),
  );

  it.effect("routes project commands through a running server when runtime state is present", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-workspace-"),
      );

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
          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const readModel = yield* projectionSnapshotQuery.getSnapshot();
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          );
          assert.isTrue(addedProject !== undefined);
          assert.equal(addedProject?.title, "Live Project");
        }),
      );
    }),
  );

  it.effect("deduplicates and persists concurrent REST bootstrap delivery", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-rest-bootstrap-test-"));
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-rest-bootstrap-workspace-"),
      );

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "REST Bootstrap Project",
            "--base-dir",
            baseDir,
          ]);

          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const project = (yield* projectionSnapshotQuery.getSnapshot()).projects.find(
            (candidate) =>
              candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
          );
          assert.isTrue(project !== undefined);
          if (project === undefined) {
            return;
          }

          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            assert.fail(`Expected TCP address, got ${address}`);
          }
          const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const session = yield* environmentAuth.issueSession({
            scopes: AuthAdministrativeScopes,
            label: "REST bootstrap test",
          });
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
            baseUrl: `http://127.0.0.1:${address.port}`,
          });
          const createdAt = "2026-01-01T00:00:00.000Z";
          const threadId = ThreadId.make("rest-bootstrap-thread");
          const modelSelection = ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection();
          const headers = { authorization: `Bearer ${session.token}` };
          const bootstrapPayload = {
            type: "thread.turn.start",
            commandId: CommandId.make("rest-bootstrap-turn"),
            threadId,
            message: {
              messageId: MessageId.make("rest-bootstrap-message"),
              role: "user",
              text: "hello from REST",
              attachments: [],
            },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: project.id,
                title: "REST Bootstrap Thread",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: workspaceRoot,
                createdAt,
              },
            },
            createdAt,
          } as const;

          const [result, concurrentResult] = yield* Effect.all(
            [
              client.orchestration.dispatch({ headers, payload: bootstrapPayload }),
              client.orchestration.dispatch({ headers, payload: bootstrapPayload }),
            ],
            { concurrency: "unbounded" },
          );

          assert.equal(result.sequence > 0, true);
          assert.equal(concurrentResult.sequence, result.sequence);
          const snapshot = yield* projectionSnapshotQuery.getSnapshot();
          const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
          assert.equal(thread?.title, "REST Bootstrap Thread");
          assert.equal(thread?.projectId, project.id);
          assert.deepEqual(thread?.modelSelection, modelSelection);
          assert.equal(thread?.runtimeMode, "full-access");
          assert.equal(thread?.interactionMode, "default");
          assert.equal(thread?.branch, null);
          assert.equal(thread?.worktreePath, workspaceRoot);
          assert.deepEqual(
            thread?.messages.map((message) => ({ role: message.role, text: message.text })),
            [{ role: "user", text: "hello from REST" }],
          );
          const threadDetail = yield* client.orchestration.threadSnapshot({
            headers,
            params: { threadId },
          });
          assert.equal(threadDetail.thread.id, threadId);
          assert.equal(threadDetail.thread.messages[0]?.text, "hello from REST");

          const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
          const threadEvents = Array.from(
            yield* Stream.runCollect(orchestrationEngine.readEvents(0)),
          ).filter((event) => event.aggregateId === threadId);
          assert.deepEqual(
            threadEvents.map((event) => event.type),
            ["thread.created", "thread.message-sent", "thread.turn-start-requested"],
          );
          assert.equal((threadEvents[1]?.sequence ?? -1) + 1, threadEvents[2]?.sequence);

          const retryResult = yield* client.orchestration.dispatch({
            headers,
            payload: bootstrapPayload,
          });
          assert.equal(retryResult.sequence, result.sequence);
          const eventsAfterRetry = Array.from(
            yield* Stream.runCollect(orchestrationEngine.readEvents(0)),
          ).filter((event) => event.aggregateId === threadId);
          assert.deepEqual(eventsAfterRetry, threadEvents);

          const existingThreadResult = yield* client.orchestration.dispatch({
            headers,
            payload: {
              type: "thread.turn.start",
              commandId: CommandId.make("rest-existing-thread-turn"),
              threadId,
              message: {
                messageId: MessageId.make("rest-existing-thread-message"),
                role: "user",
                text: "second REST turn",
                attachments: [],
              },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt,
            },
          });
          assert.equal(existingThreadResult.sequence, result.sequence + 2);
          const existingThreadEvents = Array.from(
            yield* Stream.runCollect(orchestrationEngine.readEvents(0)),
          ).filter((event) => event.aggregateId === threadId);
          assert.deepEqual(
            existingThreadEvents.map((event) => event.type),
            [
              "thread.created",
              "thread.message-sent",
              "thread.turn-start-requested",
              "thread.message-sent",
              "thread.turn-start-requested",
            ],
          );

          const missingThreadResult = yield* Effect.result(
            client.orchestration.dispatch({
              headers,
              payload: {
                type: "thread.turn.start",
                commandId: CommandId.make("rest-missing-thread-turn"),
                threadId: ThreadId.make("rest-missing-thread"),
                message: {
                  messageId: MessageId.make("rest-missing-thread-message"),
                  role: "user",
                  text: "missing thread",
                  attachments: [],
                },
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt,
              },
            }),
          );
          assert.equal(missingThreadResult._tag, "Failure");
          if (missingThreadResult._tag === "Failure") {
            assert.equal(missingThreadResult.failure._tag, "EnvironmentRequestInvalidError");
            if (missingThreadResult.failure._tag === "EnvironmentRequestInvalidError") {
              assert.equal(missingThreadResult.failure.code, "invalid_request");
              assert.equal(missingThreadResult.failure.reason, "invalid_command");
              assert.equal(missingThreadResult.failure.traceId.length > 0, true);
            }
          }

          const failedThreadId = ThreadId.make("rest-bootstrap-cleanup-thread");
          const failedBootstrapResult = yield* Effect.result(
            client.orchestration.dispatch({
              headers,
              payload: {
                ...bootstrapPayload,
                commandId: CommandId.make("rest-bootstrap-cleanup-turn"),
                threadId: failedThreadId,
                message: {
                  ...bootstrapPayload.message,
                  messageId: MessageId.make("rest-bootstrap-cleanup-message"),
                  text: "this bootstrap must roll back",
                },
                bootstrap: {
                  createThread: {
                    ...bootstrapPayload.bootstrap.createThread,
                    title: "REST Bootstrap Cleanup Thread",
                  },
                },
                sourceProposedPlan: {
                  threadId,
                  planId: "missing-plan",
                },
              },
            }),
          );
          assert.equal(failedBootstrapResult._tag, "Failure");
          if (failedBootstrapResult._tag === "Failure") {
            assert.equal(failedBootstrapResult.failure._tag, "EnvironmentRequestInvalidError");
          }
          const failedThread = (yield* projectionSnapshotQuery.getSnapshot()).threads.find(
            (candidate) => candidate.id === failedThreadId,
          );
          assert.equal(failedThread?.deletedAt !== null, true);
          assert.deepEqual(failedThread?.messages, []);
          const failedThreadEvents = Array.from(
            yield* Stream.runCollect(orchestrationEngine.readEvents(0)),
          ).filter((event) => event.aggregateId === failedThreadId);
          assert.deepEqual(
            failedThreadEvents.map((event) => event.type),
            ["thread.created", "thread.deleted"],
          );
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      );
    }),
  );

  it.effect("rejects dev-url on project commands", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-unknown-option-workspace-"),
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
