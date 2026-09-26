// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
/**
 * Harness for CLI commands that talk to a running server (`t3 remote`,
 * `t3 peer`): a real HTTP server the CLI can discover through persisted
 * runtime state, the real auth stack behind its `/ws` upgrade, and scripted
 * RPC handlers in place of the full server.
 */
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type Rpc, type RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../bin.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(CliRuntimeLayer, TestConsole.layer));

// The test console is shared and accumulates across CLI runs, so each capture
// keeps only the entries its own run appended.
const captureNewLogLines = (args: ReadonlyArray<string>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      const before = (yield* TestConsole.logLines).length;
      yield* runCli(args);
      return (yield* TestConsole.logLines)
        .slice(before)
        .filter((line): line is string => typeof line === "string");
    }),
  );

/** Everything one CLI run logged, joined; some commands log more than once. */
export const captureStdout = (args: ReadonlyArray<string>) =>
  Effect.map(captureNewLogLines(args), (lines) => lines.join("\n"));

/** `--json` output has to be one clean entry: nothing logged before or after it. */
export const captureJson = (args: ReadonlyArray<string>) =>
  Effect.map(captureNewLogLines(args), (lines) => {
    assert.equal(lines.length, 1, `Expected exactly one JSON entry, got ${String(lines)}`);
    return lines[0] ?? "";
  });

export const flipCli = (args: ReadonlyArray<string>) =>
  provideCliTestLayers(runCli(args).pipe(Effect.flip));

export const expectShowHelpError = (error: unknown, expectedTag: string) => {
  if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
    assert.fail(`Expected ShowHelp, got ${String(error)}`);
  }
  assert.equal(error.errors[0]?._tag, expectedTag);
  return error.errors[0];
};

export const makeTempBaseDir = (prefix: string) =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-cli-${prefix}-`));

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Warn",
      traceMinLevel: "Info",
      traceTimingEnabled: false,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otelEnvironment: OtelEnvironment.none,
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
      startupPresentation: "headless",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      tailcatEnabled: undefined,
      tailcatBinaryPath: undefined,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

// Discovery probes the well-known descriptor before trusting runtime state.
const descriptorRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/t3/environment",
  HttpServerResponse.jsonUnsafe({
    environmentId: "cli-test-environment",
    label: "cli-test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.1",
    capabilities: { repositoryIdentity: true },
  }),
);

/**
 * Serves `rpcs` on `/ws` behind the server's own upgrade authentication (the
 * CLI sends its minted session as a bearer header), persists runtime state so
 * the CLI discovers this server under `baseDir`, then runs `run`.
 */
export const withLiveCliServer = <Rpcs extends Rpc.Any, A, E, R>(input: {
  readonly baseDir: string;
  readonly rpcs: RpcGroup.RpcGroup<Rpcs>;
  readonly handlers: Layer.Layer<Rpc.ToHandler<Rpcs>>;
  readonly run: () => Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(input.baseDir);
    const wsRouteLayer = HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const authenticated = yield* Effect.result(
          serverAuth.authenticateWebSocketUpgrade(request),
        );
        if (authenticated._tag === "Failure") {
          return HttpServerResponse.empty({ status: 401 });
        }
        return yield* RpcServer.toHttpEffectWebsocket(input.rpcs, { disableTracing: true }).pipe(
          Effect.provide(input.handlers.pipe(Layer.provideMerge(RpcSerialization.layerJson))),
          Effect.flatMap((httpEffect) => httpEffect),
        );
      }),
    );
    const appLayer = HttpRouter.serve(Layer.mergeAll(descriptorRouteLayer, wsRouteLayer), {
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
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      // The server shares the test console with the CLI under test; keep its
      // own startup chatter out of the captured output.
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return yield* Effect.die(new Error(`Expected TCP address, got ${String(address)}`));
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({ config, port: address.port }),
        });
        return yield* input.run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });
