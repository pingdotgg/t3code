// @effect-diagnostics nodeBuiltinImport:off - checks the host's default Codex directory without writing to it.
import * as NodeURL from "node:url";
import * as NodeHttp from "node:http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexManagedRuntime, type CodexEffectiveRuntime } from "./CodexManagedRuntime.ts";
import { checkCodexProviderStatus, withCodexAppServerClient } from "./CodexProvider.ts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(CodexSettings);
const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
);
// An explicit binary enables native protocol proof without making routine tests
// depend on a globally installed CLI or a real ChatGPT account.
const nativeCodexBinary = process.env.T3CODE_TEST_CODEX_BINARY;
const exerciseNativeRenewal = Effect.fn("CodexManagedRuntime.test.nativeRenewal")(function* <
  A,
  E,
  R,
>(binaryPath: string, effective: CodexEffectiveRuntime, renew: Effect.Effect<A, E, R>) {
  const expiredRequest = Promise.withResolvers<NodeHttp.ServerResponse>();
  const requests: string[] = [];
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, Error>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        request.on("error", () => response.destroy());
        request.resume();
        if (request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const credential =
          request.headers.authorization === "Bearer dummy-owned-access"
            ? "initial"
            : request.headers.authorization === "Bearer renewed-access"
              ? "renewed"
              : "unexpected";
        requests.push(credential);
        if (credential === "initial") {
          expiredRequest.resolve(response);
          return;
        }
        if (credential !== "renewed") {
          response.writeHead(403).end();
          return;
        }
        const message = {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "renewal survived", annotations: [] }],
        };
        const events = [
          {
            type: "response.created",
            response: { id: "resp_fixture", status: "in_progress", output: [] },
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          {
            type: "response.completed",
            response: {
              id: "resp_fixture",
              status: "completed",
              output: [message],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      });
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  assert.isNotNull(address);
  if (!address || typeof address === "string") return yield* Effect.die("Missing fixture port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const args = [
    `model_providers.openai_token_sharing.base_url=${JSON.stringify(baseUrl)}`,
    `model_providers.openai_token_sharing.model_catalog_url=${JSON.stringify(`${baseUrl}/models`)}`,
    "features.apps=false",
    "features.plugins=false",
    "check_for_update_on_startup=false",
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const children: ChildProcessSpawner.ChildProcessHandle[] = [];
  yield* Effect.gen(function* () {
    const { client } = yield* withCodexAppServerClient({
      binaryPath,
      homePath: effective.config.homePath,
      launchArgs: `${effective.config.launchArgs} ${args}`,
      cwd: effective.config.homePath,
      environment: effective.environment,
    });
    const completed = yield* Deferred.make<CodexSchema.V2TurnCompletedNotification>();
    yield* client.handleServerNotification("turn/completed", (payload) =>
      Deferred.succeed(completed, payload),
    );
    const thread = yield* client.request("thread/start", {
      cwd: effective.config.homePath,
      model: "gpt-5.4-mini",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const turn = yield* client.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: "Reply with a short greeting." }],
    });
    const response = yield* Effect.promise(() => expiredRequest.promise);
    yield* renew;
    response.writeHead(401, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "token_expired",
          message: "Provided authentication token is expired.",
        },
      }),
    );
    const finished = yield* Deferred.await(completed);
    assert.equal(finished.threadId, thread.thread.id);
    assert.equal(finished.turn.id, turn.turn.id);
    assert.equal(finished.turn.status, "completed");
    assert.deepEqual(requests, ["initial", "renewed"]);
    assert.lengthOf(children, 1);
    assert.isTrue(yield* children[0]!.isRunning);
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.tap((child) =>
            Effect.sync(() => {
              children.push(child);
            }),
          ),
        ),
      ),
    ),
  );
  assert.isFalse(yield* children[0]!.isRunning);
  const provider = yield* checkCodexProviderStatus(
    {
      ...effective.config,
      binaryPath,
      launchArgs: `${effective.config.launchArgs} ${args}`,
    },
    undefined,
    effective.environment,
    { status: "authenticated", type: "chatgpt", label: "ChatGPT" },
  );
  assert.equal(provider.status, "ready");
  assert.equal(provider.auth.status, "authenticated");
});
it.live.each(
  (["managed", "local"] as const).flatMap((source) =>
    (["primary", "additional"] as const).map((account) => ({ source, account })),
  ),
)(
  "$source Codex $account account shares home state without routing owned tokens through ambient CLI overrides",
  ({ source, account }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make(
        account === "primary" ? "codex" : "codex-personal",
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "codex-shared-home-" });
      yield* fs.writeFileString(path.join(sharedHome, "auth.json"), "native-auth-unchanged");
      yield* fs.writeFileString(path.join(sharedHome, "config.toml"), "# shared config\n");
      const data = new Map<string, Uint8Array>();
      let renewals = 0;
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(data.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            data.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            data.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      let leases = 0;
      const executable = {
        executablePath:
          source === "managed" ? "/isolated/tools/codex/0.156.1/bin/codex" : "/user/bin/codex",
        managedVersionDirectory: source === "managed" ? "/isolated/tools/codex/0.156.1" : null,
        source,
        version: "0.156.1",
      };
      const layerInstaller = Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "/isolated/tools/codex",
        resolve: () => Effect.succeed(executable),
        acquire: () =>
          Effect.gen(function* () {
            leases++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                leases--;
              }),
            );
            return executable;
          }),
      });
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const json = yield* encodeJson({
          clientId: "oaiapp_test",
          accessToken: "dummy-owned-access",
          refreshToken: "dummy-refresh",
          expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
          subject: "test-user",
          email: null,
        });
        yield* store.set(new TextEncoder().encode(json));
        const sqliteOverride =
          source === "local" ? path.join(sharedHome, "sqlite-override") : undefined;
        const ambient = {
          CODEX_HOME: "/user/.codex",
          ...(sqliteOverride ? { CODEX_SQLITE_HOME: sqliteOverride } : {}),
          ACCESS_TOKEN: "ambient-bearer",
          T3CODE_HOME: path.join(sharedHome, "wrong-server-home"),
          OPENAI_API_KEY: "dummy-global-key",
          OPENAI_BASE_URL: "https://user-proxy.test",
          T3CODE_CODEX_LAUNCH_ARGS: "--config model_provider=global-proxy",
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
        };
        const runtime = yield* makeCodexManagedRuntime({
          instanceId,
          enabled: true,
          config: decodeSettings({ setupMode: "managed", homePath: sharedHome }),
          environment: ambient,
        });
        yield* Effect.gen(function* () {
          const effective = yield* runtime.resolve;
          assert.strictEqual(leases, 1);
          assert.strictEqual(effective.config.binaryPath, executable.executablePath);
          assert.notStrictEqual(effective.config.homePath, ambient.CODEX_HOME);
          assert.equal(runtime.homeLayout.sharedHomePath, sharedHome);
          assert.equal(
            effective.environment.CODEX_SQLITE_HOME,
            sqliteOverride ?? (account === "additional" ? sharedHome : undefined),
          );
          if (account === "primary") {
            assert.equal(effective.config.homePath, sharedHome);
            assert.equal(runtime.homeLayout.mode, "direct");
          } else {
            assert.include(effective.config.homePath, instanceId);
            assert.include(effective.config.homePath, path.join("userdata", "providers", "codex"));
            assert.equal(runtime.homeLayout.mode, "authOverlay");
            assert.equal(
              yield* fs.readLink(path.join(effective.config.homePath, "sessions")),
              path.join(sharedHome, "sessions"),
            );
            assert.equal(
              yield* fs.readLink(path.join(effective.config.homePath, "config.toml")),
              path.join(sharedHome, "config.toml"),
            );
            assert.isFalse(yield* fs.exists(path.join(effective.config.homePath, "auth.json")));
          }
          assert.isUndefined(effective.environment.ACCESS_TOKEN);
          assert.isUndefined(effective.environment.OPENAI_API_KEY);
          assert.isUndefined(effective.environment.OPENAI_BASE_URL);
          assert.isUndefined(effective.environment.T3CODE_CODEX_LAUNCH_ARGS);
          const args = codexAppServerArgs(effective.config.launchArgs);
          assert.include(args, 'model_provider="openai_token_sharing"');
          const provider = args.find((arg) =>
            arg.startsWith("model_providers.openai_token_sharing="),
          )!;
          assert.include(provider, 'base_url="https://api.openai.com/v1"');
          assert.include(provider, 'model_catalog_url="https://api.openai.com/v1/models"');
          assert.notInclude(provider, "env_key");
          assert.include(provider, "refresh_interval_ms=0");
          if (nativeCodexBinary && source === "managed" && account === "additional") {
            yield* exerciseNativeRenewal(
              nativeCodexBinary,
              effective,
              Effect.gen(function* () {
                const saved = Option.getOrThrow(yield* runtime.auth.read);
                const expired = yield* encodeJson({ ...saved, expiresAt: 0 });
                yield* store.set(new TextEncoder().encode(expired));
                assert.equal((yield* runtime.auth.access).accessToken, "renewed-access");
                assert.equal(
                  Option.getOrThrow(yield* runtime.auth.read).refreshToken,
                  "renewed-refresh",
                );
                assert.equal(renewals, 1);
              }),
            );
            assert.isTrue(yield* fs.exists(path.join(sharedHome, "state_5.sqlite")));
            assert.deepEqual(
              (yield* fs.readDirectory(runtime.homePath)).filter((name) =>
                name.includes(".sqlite"),
              ),
              [],
            );
            assert.equal((yield* runtime.resolve).revision, effective.revision);
          }
          // regression: #16132 Codex fetches each token through this helper, so a running
          // session picks up renewals instead of keeping the token it launched with.
          if (source === "managed" && account === "primary") {
            const commandMatch = /auth=\{command=(.*),args=(\[.*\]),timeout_ms=/u.exec(provider);
            assert.isNotNull(commandMatch);
            const [command, helperArgs] = decodeCommand(
              `[${commandMatch![1]},${commandMatch![2]}]`,
            );
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const runHelper = Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(command, helperArgs, {
                  extendEnv: false,
                  env: effective.environment,
                }),
              );
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                  child.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return { stdout, stderr, code: Number(code) };
            }).pipe(Effect.scoped);
            assert.deepEqual(yield* runHelper, {
              stdout: "dummy-owned-access",
              stderr: "",
              code: 0,
            });
            const saved = Option.getOrThrow(yield* runtime.auth.read);
            const expired = yield* encodeJson({ ...saved, expiresAt: 0 });
            yield* store.set(new TextEncoder().encode(expired));
            assert.deepEqual(yield* runHelper, { stdout: "renewed-access", stderr: "", code: 0 });
            assert.equal(renewals, 1);
            assert.equal(
              Option.getOrThrow(yield* runtime.auth.read).refreshToken,
              "renewed-refresh",
            );
            assert.equal((yield* runtime.resolve).revision, effective.revision);
            const replaced = yield* encodeJson({ ...saved, subject: "replacement-user" });
            yield* store.set(new TextEncoder().encode(replaced));
            const refused = yield* runHelper;
            assert.equal(refused.code, 1);
            assert.equal(refused.stdout, "");
            assert.isFalse(yield* fs.exists(ambient.T3CODE_HOME));
          }
          assert.include(args, "features.api_key_model_discovery=true");
          assert.include(args, "features.multi_agent=false");
          assert.include(args, "features.multi_agent_v2=false");
          assert.notInclude(effective.config.launchArgs, "model_catalog_json");
          assert.notInclude(effective.config.launchArgs, "x-openai-chatpass-test");
          assert.include(provider, "supports_websockets=false");
          assert.include(provider, "requires_openai_auth=false");
          for (const secret of ["dummy-owned-access", "dummy-refresh", "ambient-bearer"]) {
            assert.notInclude(effective.config.launchArgs, secret);
            assert.notInclude(JSON.stringify(effective.environment), secret);
          }
          assert.strictEqual(ambient.CODEX_HOME, "/user/.codex");
        }).pipe(Effect.scoped);
        assert.strictEqual(leases, 0);
        yield* runtime.auth.controller.logout(Effect.void);
        assert.equal(
          yield* fs.readFileString(path.join(sharedHome, "auth.json")),
          "native-auth-unchanged",
        );
      }).pipe(
        Effect.provide(CodexManagedTokenBroker.layer),
        Effect.provideService(HostProcess.Arguments, [
          process.execPath,
          NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        ]),
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
          ),
        }),
        Effect.provide(layerInstaller),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              assert.isTrue(
                [
                  "https://auth.openai.com/.well-known/openid-configuration",
                  "https://auth.openai.com/revoke",
                  "https://auth.openai.com/api/accounts/oauth/token",
                ].includes(request.url),
              );
              if (request.url.endsWith("/token")) {
                renewals++;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    access_token: "renewed-access",
                    refresh_token: "renewed-refresh",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "chatgpt.tokens.use.direct",
                  }),
                );
              }
              return HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/revoke")
                  ? new Response(null, { status: 200 })
                  : Response.json({
                      issuer: "https://auth.openai.com",
                      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                      jwks_uri: "https://auth.openai.com/jwks",
                      revocation_endpoint: "https://auth.openai.com/revoke",
                    }),
              );
            }),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-managed-runtime-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
