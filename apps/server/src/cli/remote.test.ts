// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentTailcatHttpApi,
  type TailcatConnectionCodeResult,
  TailcatRemoteAccessError,
  TailcatRemoteAccessState,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../bin.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { tailcatHttpApiLayer } from "../tailcat/http.ts";
import * as TailcatRemoteAccess from "../tailcat/TailcatRemoteAccess.ts";
import { NoRunningServerError } from "./pair.ts";
import { TailcatUnavailableError } from "./remote.ts";

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

/** Everything one CLI run logged, joined; commands may log more than once (`enable` adds a hint). */
const captureStdout = (args: ReadonlyArray<string>) =>
  Effect.map(captureNewLogLines(args), (lines) => lines.join("\n"));

/** `--json` output has to be one clean entry: nothing logged before or after it. */
const captureJson = (args: ReadonlyArray<string>) =>
  Effect.map(captureNewLogLines(args), (lines) => {
    assert.equal(lines.length, 1, `Expected exactly one JSON entry, got ${String(lines)}`);
    return lines[0] ?? "";
  });

const flipCli = (args: ReadonlyArray<string>) =>
  provideCliTestLayers(runCli(args).pipe(Effect.flip));

const expectShowHelpError = (error: unknown, expectedTag: string) => {
  if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
    assert.fail(`Expected ShowHelp, got ${String(error)}`);
  }
  assert.equal(error.errors[0]?._tag, expectedTag);
};

const makeTempBaseDir = (prefix: string) =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-remote-cli-${prefix}-`));

const testDescriptor = {
  environmentId: "remote-test-environment",
  label: "remote-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

// Discovery probes the well-known descriptor before trusting runtime state;
// the tailcat API itself is the real handler layer over a scripted service.
const descriptorRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/t3/environment",
  HttpServerResponse.jsonUnsafe(testDescriptor),
);

class RemoteCliHttpApi extends HttpApi.make("environment").add(EnvironmentTailcatHttpApi) {}

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

const TAILCAT_ADDRESS = "tcAbCdEfGhIjKlMnOpQrStUv";
const NODE_KEY = `nodekey:${"0123456789abcdef".repeat(4)}`;

const readyState: TailcatRemoteAccessState = {
  enabled: true,
  status: "ready",
  address: TAILCAT_ADDRESS,
  remotePort: 3773,
  pairingOpen: false,
  trustedPeers: [
    {
      id: "peer-phone",
      nodeKey: NODE_KEY,
      label: "Phone",
      createdAt: "2026-06-20T00:00:00.000Z",
      lastSeenAt: "2026-06-21T08:30:00.000Z",
      sessionIds: [],
    },
  ],
  runtime: {
    executablePath: "/opt/t3/tailcat",
    source: "bundled",
    version: "1.4.0",
    pinnedVersion: "1.4.0",
    compatible: true,
  },
  identityFingerprint: "SHA256:remote-test",
  lastError: null,
  updatedAt: "2026-06-21T08:30:00.000Z",
};

const disabledState: TailcatRemoteAccessState = {
  ...readyState,
  enabled: false,
  status: "disabled",
  address: null,
  remotePort: null,
};

const unavailableState: TailcatRemoteAccessState = {
  ...disabledState,
  status: "unavailable",
  runtime: null,
  lastError: {
    code: "binary-missing",
    message: "The tailcat binary was not found.",
    at: "2026-06-21T08:30:00.000Z",
  },
};

const connectionCode: TailcatConnectionCodeResult = {
  code: "t3c://tailcat/remote-test-code",
  payload: { v: 1, transport: "tailcat", address: TAILCAT_ADDRESS, port: 3773 },
  pairingLinkId: "pairing-link-1",
  expiresAt: "2026-06-21T08:35:00.000Z",
};

const makeScriptedRemoteAccess = (initial: TailcatRemoteAccessState) =>
  Effect.map(Ref.make(initial), (stateRef) => ({
    stateRef,
    service: TailcatRemoteAccess.TailcatRemoteAccess.of({
      state: Ref.get(stateRef),
      changes: Stream.empty,
      readyEndpoint: Effect.succeed(Option.none()),
      start: () => Effect.void,
      setEnabled: (enabled) =>
        Ref.updateAndGet(stateRef, (state) =>
          enabled
            ? {
                ...state,
                enabled: true,
                status: "ready",
                address: TAILCAT_ADDRESS,
                remotePort: 3773,
              }
            : { ...state, enabled: false, status: "disabled", address: null, remotePort: null },
        ),
      createConnectionCode: () => Effect.succeed(connectionCode),
      recordTrustedPeer: () => Effect.void,
      revokeTrustedPeer: (peerId) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(stateRef);
          if (!current.trustedPeers.some((peer) => peer.id === peerId)) {
            return yield* new TailcatRemoteAccessError({
              code: "unknown",
              message: "That device is no longer in the trusted list.",
            });
          }
          return yield* Ref.updateAndGet(stateRef, (state) => ({
            ...state,
            trustedPeers: state.trustedPeers.filter((peer) => peer.id !== peerId),
          }));
        }),
      renameTrustedPeer: () => Ref.get(stateRef),
      regenerateIdentity: Ref.get(stateRef),
    }),
  }));

/**
 * A server the CLI can discover: descriptor route, the real tailcat HTTP
 * handlers over a scripted service, and the real auth middleware backed by
 * the sqlite database the CLI mints its session into.
 */
const withLiveTailcatServer = <A, E, R>(
  baseDir: string,
  remoteAccess: TailcatRemoteAccess.TailcatRemoteAccess["Service"],
  run: () => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = Layer.mergeAll(
      HttpApiBuilder.layer(RemoteCliHttpApi).pipe(
        Layer.provide(
          tailcatHttpApiLayer.pipe(
            Layer.provide(Layer.succeed(TailcatRemoteAccess.TailcatRemoteAccess, remoteAccess)),
          ),
        ),
        Layer.provide(environmentAuthenticatedAuthLayer),
      ),
      descriptorRouteLayer,
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
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
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
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

const decodeStateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TailcatRemoteAccessState));
const isTailcatRemoteAccessError = Schema.is(TailcatRemoteAccessError);
const isTailcatUnavailableError = Schema.is(TailcatUnavailableError);
const isNoRunningServerError = Schema.is(NoRunningServerError);

it.layer(NodeServices.layer)("t3 remote tailcat", (it) => {
  it.effect("registers every tailcat subcommand", () =>
    Effect.gen(function* () {
      const output = yield* captureStdout(["remote", "tailcat", "--help"]);

      for (const subcommand of ["status", "enable", "disable", "code", "peers", "revoke"]) {
        assert.include(output, subcommand);
      }
      assert.include(output, "Manage Tailcat remote access on the running server.");
    }),
  );

  it.effect("rejects a missing or blank peer id before contacting any server", () =>
    Effect.gen(function* () {
      expectShowHelpError(yield* flipCli(["remote", "tailcat", "revoke"]), "MissingArgument");
      expectShowHelpError(yield* flipCli(["remote", "tailcat", "revoke", "   "]), "InvalidValue");
    }),
  );

  it.effect("reports remote access state and trusted peers from the running server", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("status");
      const remoteAccess = yield* makeScriptedRemoteAccess(readyState);

      yield* withLiveTailcatServer(baseDir, remoteAccess.service, () =>
        Effect.gen(function* () {
          const status = yield* captureStdout([
            "remote",
            "tailcat",
            "status",
            "--base-dir",
            baseDir,
          ]);
          assert.include(status, "Tailcat remote access");
          assert.include(status, "Enabled: yes");
          assert.include(status, "Status: ready");
          assert.include(status, `Address: ${TAILCAT_ADDRESS}`);
          assert.include(status, "Pairing window: closed");
          assert.include(status, "Runtime: bundled 1.4.0 (compatible) at /opt/t3/tailcat");
          assert.include(status, "Trusted peers: 1");
          assert.include(status, "Last error: none");

          const json = yield* captureJson([
            "remote",
            "tailcat",
            "status",
            "--base-dir",
            baseDir,
            "--json",
          ]);
          assert.deepEqual(yield* decodeStateJson(json), readyState);

          const peers = yield* captureStdout(["remote", "tailcat", "peers", "--base-dir", baseDir]);
          assert.include(peers, "peer-phone (Phone)");
          assert.include(peers, "node key: 0123·4567·cdef");
          assert.include(peers, "created: 2026-06-20T00:00:00.000Z");
          assert.include(peers, "last seen: 2026-06-21T08:30:00.000Z");
        }),
      );
    }),
  );

  it.effect("enables, mints a connection code, revokes a peer, and disables again", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("toggle");
      const remoteAccess = yield* makeScriptedRemoteAccess(disabledState);

      yield* withLiveTailcatServer(baseDir, remoteAccess.service, () =>
        Effect.gen(function* () {
          const enabled = yield* captureStdout([
            "remote",
            "tailcat",
            "enable",
            "--base-dir",
            baseDir,
          ]);
          assert.include(enabled, "Status: ready");
          assert.include(enabled, `Address: ${TAILCAT_ADDRESS}`);
          assert.include(enabled, "Next: run `t3 remote tailcat code`");
          assert.isTrue((yield* Ref.get(remoteAccess.stateRef)).enabled);

          const code = yield* captureStdout([
            "remote",
            "tailcat",
            "code",
            "--base-dir",
            baseDir,
            "--label",
            "Laptop",
          ]);
          assert.include(code, "Connection code (expires 2026-06-21T08:35:00.000Z, single use):");
          assert.include(code, "t3c://tailcat/remote-test-code");
          assert.isTrue(code.includes("█") || code.includes("▀") || code.includes("▄"));
          assert.include(code, "one-time pairing credential");

          const revoked = yield* captureStdout([
            "remote",
            "tailcat",
            "revoke",
            "peer-phone",
            "--base-dir",
            baseDir,
          ]);
          assert.include(revoked, "Revoked trusted peer peer-phone. 0 trusted peer(s) remain.");

          // The server's typed failure surfaces with its own wording.
          const revokedAgain = yield* flipCli([
            "remote",
            "tailcat",
            "revoke",
            "peer-phone",
            "--base-dir",
            baseDir,
          ]);
          if (!isTailcatRemoteAccessError(revokedAgain)) {
            assert.fail(`Expected TailcatRemoteAccessError, got ${String(revokedAgain)}`);
          }
          assert.equal(revokedAgain.message, "That device is no longer in the trusted list.");

          const disabled = yield* captureStdout([
            "remote",
            "tailcat",
            "disable",
            "--base-dir",
            baseDir,
          ]);
          assert.include(disabled, "Tailcat remote access is disabled.");
          assert.isFalse((yield* Ref.get(remoteAccess.stateRef)).enabled);
        }),
      );
    }),
  );

  it.effect("fails with the binary override hint when the server reports Tailcat unavailable", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("unavailable");
      const remoteAccess = yield* makeScriptedRemoteAccess(unavailableState);

      yield* withLiveTailcatServer(baseDir, remoteAccess.service, () =>
        Effect.gen(function* () {
          const error = yield* flipCli(["remote", "tailcat", "status", "--base-dir", baseDir]);

          if (!isTailcatUnavailableError(error)) {
            assert.fail(`Expected TailcatUnavailableError, got ${String(error)}`);
          }
          assert.equal(error.code, "binary-missing");
          assert.include(error.message, "The tailcat binary was not found.");
          assert.include(error.message, "T3CODE_TAILCAT_BINARY");
        }),
      );
    }),
  );

  it.effect("directs to t3 serve when no server is running", () =>
    Effect.gen(function* () {
      const baseDir = makeTempBaseDir("none");

      const error = yield* flipCli(["remote", "tailcat", "status", "--base-dir", baseDir]);

      if (!isNoRunningServerError(error)) {
        assert.fail(`Expected NoRunningServerError, got ${String(error)}`);
      }
      assert.include(error.message, "No running T3 Code server found.");
      assert.include(error.message, "npx t3 serve");
    }),
  );
});
