// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - checks the host's default Codex directory without writing to it.
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
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
import { makeCodexManagedTokenSource } from "./CodexManagedTokenSource.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";
import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(CodexSettings);
it.effect("closes the managed credential bridge with its provider scope", () =>
  Effect.gen(function* () {
    const source = yield* makeCodexManagedTokenSource(
      ProviderInstanceId.make("closed-codex"),
      Effect.succeed({ accessToken: "dummy-token", clientId: "dummy-account" }),
    ).pipe(Effect.scoped);
    const reached = yield* Effect.promise(() =>
      fetch(source.url).then(
        () => true,
        () => false,
      ),
    );
    assert.isFalse(reached);
  }),
);
it.effect("managed home defaults to the global Codex home and honors configured home paths", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const primary = yield* resolveManagedCodexHomeLayout(
      "/t3-state",
      ProviderInstanceId.make("codex"),
      decodeSettings({}),
    );
    assert.equal(primary.sharedHomePath, path.join(NodeOS.homedir(), ".codex"));
    assert.equal(primary.mode, "direct");
    const additional = yield* resolveManagedCodexHomeLayout(
      "/t3-state",
      ProviderInstanceId.make("codex-work"),
      decodeSettings({}),
    );
    assert.equal(additional.sharedHomePath, primary.sharedHomePath);
    assert.equal(additional.mode, "authOverlay");
    const configured = yield* resolveManagedCodexHomeLayout(
      "/t3-state",
      ProviderInstanceId.make("codex-work"),
      decodeSettings({ homePath: "/custom/shared", shadowHomePath: "/custom/shadow" }),
    );
    assert.equal(configured.sharedHomePath, "/custom/shared");
    assert.equal(configured.effectiveHomePath, "/custom/shadow");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(
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
          OPENAI_API_KEY: "dummy-global-key",
          OPENAI_BASE_URL: "https://user-proxy.test",
          T3CODE_CODEX_LAUNCH_ARGS: "--config model_provider=global-proxy",
          PATH: "/usr/bin",
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
          // Emulate the same app-server making later requests, without resolving
          // or restarting its runtime. Run its configured credential command.
          const requestToken = Effect.promise(async () => {
            const argv = codexAppServerArgs(effective.config.launchArgs);
            const prefix = "model_providers.openai_token_sharing.auth.args=";
            const commandArgs = argv.find((value) => value.startsWith(prefix));
            if (commandArgs === undefined) return effective.environment.ACCESS_TOKEN;
            const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
              process.execPath,
              JSON.parse(commandArgs.slice(prefix.length)),
              { env: effective.environment, timeout: 25_000 },
            );
            return stdout;
          });
          assert.equal(yield* requestToken, "dummy-owned-access");
          const expired = { ...JSON.parse(json), expiresAt: 0 };
          yield* store.set(new TextEncoder().encode(JSON.stringify(expired)));
          // A provider status read renews the saved token, as in the report.
          assert.equal((yield* runtime.auth.access).accessToken, "dummy-renewed-access");
          assert.deepEqual(
            yield* Effect.all([requestToken, requestToken], { concurrency: "unbounded" }),
            ["dummy-renewed-access", "dummy-renewed-access"],
          );
          assert.isUndefined(effective.environment.ACCESS_TOKEN);
          assert.notInclude(JSON.stringify(effective.environment), "dummy-owned-access");
          const rejected = yield* Effect.promise(() =>
            fetch(effective.environment.T3CODE_MANAGED_CODEX_AUTH_URL!),
          );
          assert.equal(rejected.status, 401);
          yield* store.set(
            new TextEncoder().encode(
              JSON.stringify({
                ...expired,
                clientId: "another-account",
                expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
              }),
            ),
          );
          const switched = yield* Effect.promise(() =>
            fetch(effective.environment.T3CODE_MANAGED_CODEX_AUTH_URL!, {
              headers: {
                Authorization: `Bearer ${effective.environment.T3CODE_MANAGED_CODEX_AUTH_SECRET}`,
                "X-T3-Codex-Account": effective.environment.T3CODE_MANAGED_CODEX_AUTH_ACCOUNT!,
              },
            }),
          );
          assert.equal(switched.status, 409);
          assert.equal(yield* Effect.promise(() => switched.text()), "");
          assert.isUndefined(effective.environment.OPENAI_API_KEY);
          assert.isUndefined(effective.environment.OPENAI_BASE_URL);
          assert.isUndefined(effective.environment.T3CODE_CODEX_LAUNCH_ARGS);
          const args = codexAppServerArgs(effective.config.launchArgs);
          assert.include(
            args,
            'model_providers.openai_token_sharing.base_url="https://api.openai.com/v1"',
          );
          assert.include(
            args,
            'model_providers.openai_token_sharing.model_catalog_url="https://api.openai.com/v1/models"',
          );
          assert.include(args, "features.api_key_model_discovery=true");
          assert.notInclude(effective.config.launchArgs, "model_catalog_json");
          assert.notInclude(effective.config.launchArgs, "x-openai-chatpass-test");
          assert.include(args, "model_providers.openai_token_sharing.supports_websockets=false");
          assert.include(args, "model_providers.openai_token_sharing.requires_openai_auth=false");
          assert.notInclude(effective.config.launchArgs, "dummy-owned-access");
          assert.strictEqual(ambient.CODEX_HOME, "/user/.codex");
        }).pipe(Effect.scoped);
        assert.strictEqual(leases, 0);
        yield* runtime.auth.controller.logout(Effect.void);
        assert.equal(
          yield* fs.readFileString(path.join(sharedHome, "auth.json")),
          "native-auth-unchanged",
        );
      }).pipe(
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
              return HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/revoke")
                  ? new Response(null, { status: 200 })
                  : request.url.endsWith("/token")
                    ? Response.json({
                        access_token: "dummy-renewed-access",
                        refresh_token: "dummy-rotated-refresh",
                        expires_in: 3600,
                        token_type: "Bearer",
                        scope: "chatgpt.tokens.use.direct",
                      })
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
