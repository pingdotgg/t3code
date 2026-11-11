// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeCli } from "../binCli.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  acquireRelayClientForLink,
  disconnectCloud,
  linkEnvironmentForConnect,
  withConnectCliLock,
} from "./connect.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect unlink",
  (it) => {
    const runUnlink = (recordedPid: number, options?: { readonly portFreed?: boolean }) =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const warnings: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        if (options?.portFreed) {
          yield* Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-unlink-test-" });
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: address.port,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: recordedPid },
        });

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          "unlink",
          "--base-dir",
          baseDir,
        ]).pipe(
          // TestConsole has no reader for Console.warn.
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args: ReadonlyArray<unknown>) => {
              warnings.push(args.join(" "));
            },
          })),
        );

        return { requests, warnings, printed: (yield* TestConsole.logLines).join("\n") };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );

    // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
    const deadPid = 4_194_305;

    it.effect("does not tell the user to restart a server that is gone", () =>
      Effect.gen(function* () {
        const { printed, warnings } = yield* runUnlink(deadPid, { portFreed: true });

        assert.include(printed, "T3 Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "Restart that server");
      }),
    );

    it.effect("warns that a server that is gone may have left its connector running", () =>
      Effect.gen(function* () {
        const { warnings } = yield* runUnlink(deadPid, { portFreed: true });

        assert.include(warnings.join("\n"), "its cloudflared process may still be running");
      }),
    );

    it.effect("does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runUnlink(deadPid);

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("asks a running server to stop its tunnel", () =>
      Effect.gen(function* () {
        const { requests, printed, warnings } = yield* runUnlink(process.pid);

        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.include(printed, "T3 Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "cloudflared process");
      }),
    );
  },
);

it.effect("preserves publish-only intent when beta enrollment is refused", () =>
  Effect.gen(function* () {
    const result = yield* linkEnvironmentForConnect({ headless: true, beta: true }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSecretStore.ServerSecretStore, {
            get: (name) =>
              Effect.succeed(
                name === CliState.CLOUD_CLI_DESIRED_LINK_SECRET
                  ? Option.some(new TextEncoder().encode("publish_only"))
                  : Option.none(),
              ),
          }),
          Layer.mock(RelayClient.RelayClient, {}),
          Layer.mock(CliTokenManager.CloudCliTokenManager, {}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected network request")),
          ),
          Layer.succeed(HostProcess.Environment, {}),
          NodeServices.layer,
        ),
      ),
      Effect.flip,
    );
    assert.isTrue(result._tag === "UserError" && result.userMessage?.includes("unlink") === true);
  }),
);

it.effect(
  "retries unlink on the relay that received beta enrollment after the configured relay changes",
  () => {
    const deleted: string[] = [];
    const attemptId = "b7a4ec52-819c-409a-b377-680565691bf8";
    return Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(
        CliState.CLOUD_CLI_BETA_ENROLLMENT_RELAY,
        new TextEncoder().encode(
          JSON.stringify({ relayUrl: "https://owner.example.test", attemptId, owner: "user" }),
        ),
      );
      yield* disconnectCloud({ clearAuthorization: false });
      assert.isTrue(Option.isSome(yield* secrets.get(CliState.CLOUD_CLI_BETA_ENROLLMENT_RELAY)));
      yield* disconnectCloud({ clearAuthorization: false });
      assert.isTrue(Option.isNone(yield* secrets.get(CliState.CLOUD_CLI_BETA_ENROLLMENT_RELAY)));
      assert.deepEqual(
        deleted,
        Array(2).fill("https://owner.example.test/v1/client/environment-links/env-1"),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSecretStore.layer,
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {}),
          Layer.mock(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
          }),
          Layer.mock(CliTokenManager.CloudCliTokenManager, {
            getExisting: Effect.succeedSome({
              accessToken: "fixture",
              refreshToken: "fixture",
              expiresAtEpochMs: 1,
            }),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                assert.equal(request.headers["x-t3-beta-enrollment-id"], attemptId);
                assert.equal(request.headers["x-t3-beta-enrollment-owner"], "user");
                deleted.push(request.url);
                return HttpClientResponse.fromWeb(
                  request,
                  deleted.length === 1
                    ? new Response(null, { status: 503 })
                    : Response.json({ ok: true }),
                );
              }),
            ),
          ),
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest("/", { prefix: "t3-cli-beta-unlink-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { T3CODE_RELAY_URL: "https://wrong.example.test" } }),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect("another Connect change cannot remove an enrollment while unlink is in flight", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-exclusive-" });
    const file = path.join(dir, "connect-cli.sqlite");
    yield* withConnectCliLock(
      file,
      Effect.gen(function* () {
        const collision = yield* Effect.flip(
          withConnectCliLock(file, Effect.die("overlapping link change ran")),
        );
        assert.include(collision.userMessage ?? "", "already changing");
      }),
    );
    yield* withConnectCliLock(file, Effect.void);
  }).pipe(Effect.provide(NodeServices.layer)),
);
