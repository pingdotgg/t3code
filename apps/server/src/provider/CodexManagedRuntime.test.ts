// @effect-diagnostics nodeBuiltinImport:off - checks the host's default Codex directory without writing to it.
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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
import { makeCodexManagedRuntime } from "./CodexManagedRuntime.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(CodexSettings);
const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
);
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
        const ambient = {
          CODEX_HOME: "/user/.codex",
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
          if (account === "primary") {
            assert.equal(effective.config.homePath, sharedHome);
            assert.equal(runtime.homeLayout.mode, "direct");
          } else {
            assert.include(effective.config.homePath, instanceId);
            assert.include(effective.config.homePath, "userdata/providers/codex");
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
