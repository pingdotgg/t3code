// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DispatchResult,
  EnvironmentOrchestrationHttpApi,
  OrchestrationReadModel,
  OrchestrationThreadDetailSnapshot,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli, makeCli } from "./bin.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./cloud/serviceProtocol.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
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
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { environmentAuthenticatedAuthLayer } from "./auth/http.ts";

import packageJson from "../package.json" with { type: "json" };

const encodeDriveJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDriveReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(DispatchResult));
const decodeDriveSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationReadModel),
);
const decodeDriveThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);
const decodeDriveSchemaDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ $schema: Schema.String })),
);

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const DisconnectedLauncherChildLayer = Layer.mergeAll(
  Layer.succeed(HostProcessEnvironment, {
    ...process.env,
    [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: packageJson.version,
    }),
  }),
  Layer.succeed(ServiceLauncherClient.ServiceLauncherHostProcess, {
    connected: false,
    send: () => false,
    on: () => undefined,
    off: () => undefined,
  }),
);
class ProjectCliHttpApi extends HttpApi.make("environment").add(EnvironmentOrchestrationHttpApi) {}

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

const makeProjectLookupFixture = Effect.fn("makeProjectLookupFixture")(function* (
  withThread: boolean,
  removeWorkspace: boolean,
) {
  const baseDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-cli-project-lookup-state-"),
  );
  const workspaceRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-cli-project-lookup-git-"),
  );
  NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main", workspaceRoot], {
    stdio: "ignore",
  });
  yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const snapshot = yield* readPersistedSnapshot(baseDir);
  const project = snapshot.projects.find((candidate) => candidate.workspaceRoot === workspaceRoot)!;
  assert.isDefined(project);
  if (withThread) {
    const config = yield* makeCliTestServerConfig(baseDir);
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-project-lookup-thread"),
        threadId: ThreadId.make("thread-project-lookup"),
        projectId: project.id,
        title: "Project lookup test",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  }
  if (removeWorkspace) {
    NodeFS.renameSync(workspaceRoot, `${workspaceRoot}-removed`);
    assert.isFalse(NodeFS.existsSync(workspaceRoot));
  }
  return { baseDir, workspaceRoot, project };
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect("removes an empty project by ID without force after its directory is gone", () =>
    Effect.gen(function* () {
      const { baseDir, project } = yield* makeProjectLookupFixture(false, true);
      yield* runCliWithRuntime(["project", "remove", project.id, "--base-dir", baseDir]);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.isNotNull(after.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
    }),
  );

  it.effect.each([true, false])(
    "requires force for child threads, then removes by ID; missing=%s",
    (removeWorkspace) =>
      Effect.gen(function* () {
        const { baseDir, project } = yield* makeProjectLookupFixture(true, removeWorkspace);
        const error = yield* runCliWithRuntime([
          "project",
          "remove",
          project.id,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);
        assert.include(error.message, "cannot be deleted without force=true");
        const retained = yield* readPersistedSnapshot(baseDir);
        assert.isNull(
          retained.projects.find((candidate) => candidate.id === project.id)!.deletedAt,
        );
        assert.isNull(
          retained.threads.find((thread) => thread.id === "thread-project-lookup")!.deletedAt,
        );
        yield* runCliWithRuntime([
          "project",
          "remove",
          project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]);
        const after = yield* readPersistedSnapshot(baseDir);
        assert.isNotNull(
          after.projects.find((candidate) => candidate.id === project.id)!.deletedAt,
        );
        assert.isNotNull(
          after.threads.find((thread) => thread.id === "thread-project-lookup")!.deletedAt,
        );
      }),
  );

  it.effect("cannot remove the old environment's ID from a replacement empty database", () =>
    Effect.gen(function* () {
      const { baseDir, project } = yield* makeProjectLookupFixture(true, true);
      const replacementDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-project-lookup-new-state-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.include(String(error.cause), "Workspace root does not exist");
      const original = yield* readPersistedSnapshot(baseDir);
      assert.isNull(original.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
      const replacement = yield* readPersistedSnapshot(replacementDir);
      assert.equal(replacement.projects.length, 0);
    }),
  );

  it.effect("renames by ID and stored path, then force removes after the directory is gone", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture(true, true);
      yield* runCliWithRuntime([
        "project",
        "rename",
        project.id,
        "Renamed by ID",
        "--base-dir",
        baseDir,
      ]);
      const afterIdRename = yield* readPersistedSnapshot(baseDir);
      assert.equal(
        afterIdRename.projects.find((candidate) => candidate.id === project.id)!.title,
        "Renamed by ID",
      );
      yield* runCliWithRuntime([
        "project",
        "rename",
        workspaceRoot,
        "Renamed by stored path",
        "--base-dir",
        baseDir,
      ]);
      const afterPathRename = yield* readPersistedSnapshot(baseDir);
      assert.equal(
        afterPathRename.projects.find((candidate) => candidate.id === project.id)!.title,
        "Renamed by stored path",
      );
      const error = yield* runCliWithRuntime([
        "project",
        "remove",
        workspaceRoot,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "cannot be deleted without force=true");
      yield* runCliWithRuntime([
        "project",
        "remove",
        workspaceRoot,
        "--force",
        "--base-dir",
        baseDir,
      ]);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.isNotNull(after.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
      assert.isNotNull(
        after.threads.find((thread) => thread.id === "thread-project-lookup")!.deletedAt,
      );
      assert.isFalse(NodeFS.existsSync(workspaceRoot));
    }),
  );

  it.effect("preserves normalized paths and distinct symlink project entries", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture(false, false);
      const normalizedInput = `${workspaceRoot}${NodePath.sep}.`;
      yield* runCliWithRuntime([
        "project",
        "rename",
        normalizedInput,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      const renamed = yield* readPersistedSnapshot(baseDir);
      assert.equal(
        renamed.projects.find((candidate) => candidate.id === project.id)!.title,
        "Normalized",
      );
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const error = yield* runCliWithRuntime([
        "project",
        "remove",
        aliasPath,
        "--force",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      yield* runCliWithRuntime(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = yield* readPersistedSnapshot(baseDir);
      const aliasProject = added.projects.find(
        (candidate) => candidate.workspaceRoot === aliasPath,
      )!;
      assert.notEqual(aliasProject.id, project.id);
      yield* runCliWithRuntime([
        "project",
        "remove",
        `${aliasPath}${NodePath.sep}.`,
        "--base-dir",
        baseDir,
      ]);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.isNotNull(
        after.projects.find((candidate) => candidate.id === aliasProject.id)!.deletedAt,
      );
      assert.isNull(after.projects.find((candidate) => candidate.id === project.id)!.deletedAt);
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerEnvironment.identityLayer),
          Layer.provide(ServerSecretStore.layer),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
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
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

it.layer(NodeServices.layer)("bin cli parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--log-level", "debug", "--version"]));

      assert.include(output, "0.0.0");
    }),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["--no-log-websocket-events", "--version"]));

      assert.include(output, "0.0.0");
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
    }).pipe(Effect.provide(DisconnectedLauncherChildLayer)),
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
    }).pipe(Effect.provide(DisconnectedLauncherChildLayer)),
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

  it.effect("drives live project and thread commands and sends with the current thread modes", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-drive-live-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const commandFile = NodePath.join(baseDir, "command.json");
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(
            commandFile,
            yield* encodeDriveJson({
              type: "project.create",
              commandId: "drive-test-project",
              projectId: "drive-test-project",
              title: "Drive live project",
              workspaceRoot: baseDir,
              createdAt,
            }),
          );
          const projectOutput = yield* captureStdout(
            runCli(["drive", "dispatch", commandFile, "--home-dir", baseDir]),
          );
          const projectReceipt = yield* decodeDriveReceipt(projectOutput.output);
          assert.isAbove(projectReceipt.sequence, 0);
          NodeFS.writeFileSync(
            commandFile,
            yield* encodeDriveJson({
              type: "thread.create",
              commandId: "drive-test-thread",
              threadId: "drive-test-thread",
              projectId: "drive-test-project",
              title: "Drive live thread",
              modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
              runtimeMode: "full-access",
              interactionMode: "plan",
              branch: null,
              worktreePath: null,
              createdAt,
            }),
          );
          yield* runCliWithRuntime(["drive", "dispatch", commandFile, "--home-dir", baseDir]);
          const snapshotOutput = yield* captureStdout(
            runCli(["drive", "snapshot", "--home-dir", baseDir]),
          );
          const snapshot = yield* decodeDriveSnapshot(snapshotOutput.output);
          assert.equal(snapshot.projects[0]?.title, "Drive live project");
          assert.equal(snapshot.threads[0]?.title, "Drive live thread");

          const sentOutput = yield* captureStdout(
            runCli([
              "drive",
              "send",
              "drive-test-thread",
              "Verify this state",
              "--home-dir",
              baseDir,
            ]),
          );
          const sent = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                commandId: Schema.String,
                messageId: Schema.String,
                sequence: Schema.Number,
              }),
            ),
          )(sentOutput.output);
          assert.isAbove(sent.sequence, projectReceipt.sequence);
          assert.isNotEmpty(sent.commandId);
          const threadOutput = yield* captureStdout(
            runCli(["drive", "snapshot", "--thread", "drive-test-thread", "--home-dir", baseDir]),
          );
          const { thread } = yield* decodeDriveThread(threadOutput.output);
          assert.equal(thread.runtimeMode, "full-access");
          assert.equal(thread.interactionMode, "plan");
          assert.deepEqual(thread.modelSelection, {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          });
          assert.equal(thread.messages[0]?.id, sent.messageId);
          assert.equal(thread.messages[0]?.role, "user");
          assert.equal(thread.messages[0]?.text, "Verify this state");
        }),
      );
      const persisted = yield* readPersistedSnapshot(baseDir);
      assert.equal(persisted.threads[0]?.messages[0]?.text, "Verify this state");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "prints schemas and rejects synthetic commands before connecting to a live environment",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-drive-schema-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        );
        const liveSchema = yield* captureStdout(runCli(["drive", "schema"]));
        const scenarioSchema = yield* captureStdout(runCli(["drive", "schema", "--scenario"]));
        const document = yield* decodeDriveSchemaDocument(liveSchema.output);
        assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
        assert.include(liveSchema.output, "thread.turn.start");
        assert.notInclude(liveSchema.output, "thread.message.assistant.delta");
        assert.include(scenarioSchema.output, "thread.message.assistant.delta");
        const commandFile = NodePath.join(baseDir, "command.json");
        NodeFS.writeFileSync(
          commandFile,
          yield* encodeDriveJson({
            type: "thread.message.assistant.delta",
            commandId: "synthetic-delta",
            threadId: "synthetic-thread",
            messageId: "synthetic-message",
            delta: "Synthetic content",
            createdAt: DateTime.formatIso(yield* DateTime.now),
          }),
        );
        const error = yield* runCliWithRuntime([
          "drive",
          "dispatch",
          commandFile,
          "--home-dir",
          NodePath.join(baseDir, "missing"),
        ]).pipe(Effect.flip);
        assert.isTrue(Schema.isSchemaError(error));
        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "missing")));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "validates drive scenarios, preserves synthetic states, and refuses an existing home",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-cli-drive-scenario-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        );
        const scenarioFile = NodePath.join(baseDir, "scenario.json");
        const homeDir = NodePath.join(baseDir, "new-home");
        NodeFS.writeFileSync(
          scenarioFile,
          yield* encodeDriveJson({
            version: 1,
            commands: [{ type: "invalid" }],
          }),
        );
        yield* runCliWithRuntime(["drive", "scenario", scenarioFile, "--home-dir", homeDir]).pipe(
          Effect.flip,
        );
        assert.isFalse(NodeFS.existsSync(homeDir));
        const example = yield* captureStdout(runCli(["drive", "example", "--workspace", baseDir]));
        NodeFS.writeFileSync(scenarioFile, example.output);
        NodeFS.mkdirSync(homeDir);
        const marker = NodePath.join(homeDir, "keep.txt");
        NodeFS.writeFileSync(marker, "existing state");
        const error = yield* runCliWithRuntime([
          "drive",
          "scenario",
          scenarioFile,
          "--home-dir",
          homeDir,
        ]).pipe(Effect.flip);
        assert.include(String(error), "Scenario homes must not already exist");
        assert.equal(NodeFS.readFileSync(marker, "utf8"), "existing state");
        assert.deepEqual(NodeFS.readdirSync(homeDir), ["keep.txt"]);

        const scenarioHome = NodePath.join(baseDir, "scenario-home");
        yield* runCliWithRuntime(["drive", "scenario", scenarioFile, "--home-dir", scenarioHome]);
        const snapshot = yield* readPersistedSnapshot(scenarioHome);
        assert.lengthOf(snapshot.threads, 5);
        const completed = snapshot.threads.find((thread) => thread.id === "drive-completed");
        assert.deepEqual(
          completed?.messages.map((message) => message.role),
          ["user", "assistant"],
        );
        assert.include(completed?.messages[1]?.text ?? "", "Verification");
        const streaming = snapshot.threads.find((thread) => thread.id === "drive-streaming");
        assert.equal(streaming?.session?.status, "running");
        assert.equal(streaming?.messages[1]?.streaming, true);
        assert.isNotEmpty(streaming?.messages[1]?.text);
        const config = yield* makeCliTestServerConfig(scenarioHome);
        const windowed = yield* Effect.gen(function* () {
          const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          return yield* query.getThreadDetailSnapshot(ThreadId.make("drive-streaming"), {
            turnLimit: 1,
          });
        }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
        assert.isTrue(Option.isSome(windowed));
        if (Option.isSome(windowed)) {
          assert.deepEqual(
            windowed.value.thread.messages.map((message) => message.role),
            ["user", "assistant"],
          );
          assert.equal(windowed.value.thread.messages[1]?.streaming, true);
        }
        assert.equal(
          snapshot.threads.find((thread) => thread.id === "drive-error")?.session?.status,
          "error",
        );
        assert.isNotNull(
          snapshot.threads.find((thread) => thread.id === "drive-archived")?.archivedAt,
        );
      }).pipe(Effect.scoped),
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
