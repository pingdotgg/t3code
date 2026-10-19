// @effect-diagnostics nodeBuiltinImport:off - checks the host's default Codex directory without writing to it.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { codexChatGptProfileKey } from "./CodexChatGptAuth.ts";
import { makeCodexManagedRuntime } from "./CodexManagedRuntime.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";
import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(CodexSettings);

const readToken = (endpoint: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.createConnection(endpoint);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write("token\n"));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
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
    assert.equal(configured.sharedHomePath, path.resolve("/custom/shared"));
    assert.equal(configured.effectiveHomePath, path.resolve("/custom/shadow"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("prepares the local runtime before consuming refreshable credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const instanceId = ProviderInstanceId.make("codex");
    const homePath = path.join(config.baseDir, "blocked-codex-home");
    yield* fs.writeFileString(homePath, "not-a-directory");

    const data = new Map<string, Uint8Array>();
    let leases = 0;
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
    let authRequests = 0;

    yield* Effect.gen(function* () {
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      yield* store.set(
        new TextEncoder().encode(
          JSON.stringify({
            clientId: "oaiapp_test",
            accessToken: "expired-access",
            refreshToken: "refresh-must-not-be-consumed",
            expiresAt: 0,
            earliestRefreshAt: null,
            scopes: ["chatgpt.tokens.use.direct"],
            subject: "test-user",
            email: null,
          }),
        ),
      );
      const runtime = yield* makeCodexManagedRuntime({
        instanceId,
        enabled: true,
        config: decodeSettings({ setupMode: "managed", homePath }),
        environment: {},
      });
      assert.equal((yield* runtime.resolve.pipe(Effect.scoped, Effect.result))._tag, "Failure");
      assert.equal(authRequests, 0);
      assert.equal(leases, 0);
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      Effect.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "/isolated/tools/codex",
          acquire: () =>
            Effect.gen(function* () {
              leases++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  leases--;
                }),
              );
              return {
                executablePath: "/isolated/tools/codex/bin/codex",
                managedVersionDirectory: "/isolated/tools/codex",
                source: "managed" as const,
                version: "0.156.1",
              };
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authRequests++;
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }));
          }),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-managed-runtime-order-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.effect("profile-bound runtime resolution rejects a replacement before refreshing it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const instanceId = ProviderInstanceId.make("codex");
    const homePath = path.join(config.baseDir, "codex-home");
    yield* fs.makeDirectory(homePath, { recursive: true });

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
    let authRequests = 0;

    yield* Effect.gen(function* () {
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      const original = {
        clientId: "oaiapp_a",
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: Number.MAX_SAFE_INTEGER,
        earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "user-a",
        email: null,
        idToken: "identity-a",
        issuer: "https://auth.openai.com",
      };
      yield* store.set(new TextEncoder().encode(JSON.stringify(original)));
      const runtime = yield* makeCodexManagedRuntime({
        instanceId,
        enabled: true,
        config: decodeSettings({ setupMode: "managed", homePath }),
        environment: {},
      });
      yield* store.set(
        new TextEncoder().encode(
          JSON.stringify({
            ...original,
            clientId: "oaiapp_b",
            accessToken: "expired-b",
            refreshToken: "refresh-b-must-not-be-consumed",
            expiresAt: 0,
            subject: "user-b",
            idToken: "identity-b",
          }),
        ),
      );

      const result = yield* runtime
        .resolveForProfile(codexChatGptProfileKey(original))
        .pipe(Effect.scoped, Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(authRequests, 0);
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      Effect.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "/isolated/tools/codex",
          acquire: () =>
            Effect.succeed({
              executablePath: "/isolated/tools/codex/bin/codex",
              managedVersionDirectory: "/isolated/tools/codex",
              source: "managed",
              version: "0.156.1",
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authRequests++;
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }));
          }),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-managed-runtime-profile-order-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.effect("logout drains an admitted refresh before revoking and removing credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const instanceId = ProviderInstanceId.make("codex");
    const homePath = path.join(config.baseDir, "codex-home");
    yield* fs.makeDirectory(homePath, { recursive: true });

    const data = new Map<string, Uint8Array>();
    const events: string[] = [];
    const refreshEntered = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    let credentialKey: string | undefined;
    const secrets = ServerSecretStore.ServerSecretStore.of({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(data.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          data.set(key, value);
          if (key === credentialKey && new TextDecoder().decode(value).includes("rotated-refresh"))
            events.push("refresh-saved");
        }),
      remove: (key) =>
        Effect.sync(() => {
          data.delete(key);
          if (key === credentialKey) events.push("credentials-removed");
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    });

    yield* Effect.gen(function* () {
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
      credentialKey = store.binding.key;
      const original = {
        clientId: "oaiapp_test",
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: Number.MAX_SAFE_INTEGER,
        earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "test-user",
        email: null,
        idToken: "identity-a",
        issuer: "https://auth.openai.com",
      };
      yield* store.set(new TextEncoder().encode(JSON.stringify(original)));
      const runtime = yield* makeCodexManagedRuntime({
        instanceId,
        enabled: true,
        config: decodeSettings({ setupMode: "managed", homePath }),
        environment: {},
      });
      const effective = yield* runtime.auth.controller.withAccess!(runtime.resolve);
      const providerConfig = codexAppServerArgs(effective.config.launchArgs).find((arg) =>
        arg.startsWith("model_providers.openai_token_sharing_"),
      );
      const encodedAuthArgs = /args=(\[.*\]),timeout_ms=/u.exec(providerConfig!)?.[1];
      const authArgs = JSON.parse(encodedAuthArgs!) as string[];
      const endpoint = authArgs.at(-1)!;

      yield* store.set(new TextEncoder().encode(JSON.stringify({ ...original, expiresAt: 0 })));
      const helper = yield* Effect.promise(() =>
        readToken(endpoint).then(
          () => undefined,
          () => undefined,
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(refreshEntered);

      const logout = yield* runtime.auth.controller.logout(Effect.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(logout.pollUnsafe());

      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(logout);
      yield* Fiber.join(helper);

      assert.deepEqual(events, [
        "refresh-entered",
        "refresh-response",
        "refresh-saved",
        "lease-released",
        "revoke",
        "credentials-removed",
      ]);
      assert.isTrue(Option.isNone(yield* store.get));
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      Effect.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "/isolated/tools/codex",
          acquire: () =>
            Effect.acquireRelease(
              Effect.succeed({
                executablePath: "/isolated/tools/codex/bin/codex",
                managedVersionDirectory: "/isolated/tools/codex",
                source: "managed" as const,
                version: "0.156.1",
              }),
              () => Effect.sync(() => events.push("lease-released")),
            ),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.url.endsWith("/.well-known/openid-configuration"))
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  issuer: "https://auth.openai.com",
                  authorization_endpoint: "https://auth.openai.com/authorize",
                  token_endpoint: "https://auth.openai.com/token",
                  jwks_uri: "https://auth.openai.com/jwks",
                  revocation_endpoint: "https://auth.openai.com/revoke",
                }),
              ),
            );
          if (request.url === "https://auth.openai.com/token")
            return Effect.gen(function* () {
              events.push("refresh-entered");
              yield* Deferred.succeed(refreshEntered, undefined);
              yield* Deferred.await(releaseRefresh);
              events.push("refresh-response");
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "rotated-access",
                  refresh_token: "rotated-refresh",
                  expires_in: 3600,
                  token_type: "Bearer",
                  scope: "chatgpt.tokens.use.direct",
                }),
              );
            });
          if (request.url === "https://auth.openai.com/revoke") {
            events.push("revoke");
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
            );
          }
          return Effect.die(`Unexpected request: ${request.url}`);
        }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-managed-runtime-logout-order-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.effect.each(
  (["managed", "local"] as const).flatMap((source) =>
    (["primary", "additional"] as const).flatMap((account) =>
      (["node", "electron"] as const).map((runtimeHost) => ({ source, account, runtimeHost })),
    ),
  ),
)(
  "$source Codex $account account ($runtimeHost host) shares home state without routing owned tokens through ambient CLI overrides",
  ({ source, account, runtimeHost }) =>
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
          idToken: "dummy-id-token",
          issuer: "https://auth.openai.com",
        });
        yield* store.set(new TextEncoder().encode(json));
        const ambient: NodeJS.ProcessEnv = {
          ...(runtimeHost === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          CODEX_HOME: "/user/.codex",
          OPENAI_API_KEY: "dummy-global-key",
          OPENAI_BASE_URL: "https://user-proxy.test",
          T3CODE_CODEX_LAUNCH_ARGS: "--config model_provider=global-proxy",
          PATH: "/usr/bin",
        };
        const ambientBefore = JSON.stringify(ambient);
        const runtime = yield* makeCodexManagedRuntime({
          instanceId,
          enabled: true,
          config: decodeSettings({ setupMode: "managed", homePath: sharedHome }),
          environment: ambient,
        });
        yield* Effect.gen(function* () {
          const effective = yield* runtime.auth.controller.withAccess!(runtime.resolve);
          assert.strictEqual(leases, 1);
          assert.strictEqual(effective.config.binaryPath, executable.executablePath);
          assert.notStrictEqual(effective.config.homePath, ambient.CODEX_HOME);
          assert.equal(runtime.homeLayout.sharedHomePath, sharedHome);
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
          assert.strictEqual(
            effective.environment.ELECTRON_RUN_AS_NODE,
            ambient.ELECTRON_RUN_AS_NODE,
          );
          assert.isUndefined(effective.environment.T3CODE_MANAGED_CODEX_AUTH_URL);
          assert.isUndefined(effective.environment.T3CODE_MANAGED_CODEX_AUTH_SECRET);
          assert.isUndefined(effective.environment.OPENAI_API_KEY);
          assert.isUndefined(effective.environment.OPENAI_BASE_URL);
          assert.isUndefined(effective.environment.T3CODE_CODEX_LAUNCH_ARGS);
          const args = codexAppServerArgs(effective.config.launchArgs);
          assert.isTrue(
            args.some(
              (arg) => arg.startsWith("model_provider=") && arg.includes("openai_token_sharing_"),
            ),
          );
          const providerConfig = args.find((arg) =>
            arg.startsWith("model_providers.openai_token_sharing_"),
          );
          assert.isDefined(providerConfig);
          assert.include(providerConfig!, 'base_url="https://api.openai.com/v1"');
          assert.include(providerConfig!, 'model_catalog_url="https://api.openai.com/v1/models"');
          assert.include(args, "features.api_key_model_discovery=true");
          assert.include(args, "features.multi_agent=false");
          assert.include(args, "features.multi_agent_v2=false");
          assert.notInclude(effective.config.launchArgs, "shell_environment_policy");
          assert.include(providerConfig!, "auth={");
          assert.include(providerConfig!, "command=");
          assert.include(providerConfig!, "args=");
          assert.include(providerConfig!, "timeout_ms=80000");
          assert.include(providerConfig!, "refresh_interval_ms=0");
          const encodedAuthArgs = /args=(\[.*\]),timeout_ms=/u.exec(providerConfig!)?.[1];
          assert.isDefined(encodedAuthArgs);
          const authArgs = JSON.parse(encodedAuthArgs!) as string[];
          assert.include(authArgs, "__managed-chatgpt-token");
          const endpoint = authArgs.at(-1);
          assert.isDefined(endpoint);
          const token = yield* Effect.promise(() => readToken(endpoint!));
          assert.equal(token, "dummy-owned-access");
          assert.notInclude(providerConfig!, 'env_key="ACCESS_TOKEN"');
          assert.notInclude(effective.config.launchArgs, "model_catalog_json");
          assert.notInclude(effective.config.launchArgs, "x-openai-chatpass-test");
          assert.include(providerConfig!, "supports_websockets=false");
          assert.include(providerConfig!, "requires_openai_auth=false");
          for (const sensitive of [
            "dummy-owned-access",
            "dummy-refresh",
            "dummy-id-token",
            "test-user",
          ]) {
            assert.notInclude(effective.config.launchArgs, sensitive);
            assert.notInclude(JSON.stringify(effective.environment), sensitive);
          }
          assert.strictEqual(ambient.CODEX_HOME, "/user/.codex");
          if (source === "managed" && account === "primary") {
            yield* runtime.auth.controller.logout(Effect.void);
            const closed = yield* Effect.promise(() =>
              readToken(endpoint!).then(
                () => false,
                () => true,
              ),
            );
            assert.isTrue(closed);
          } else if (source === "local" && account === "primary" && runtimeHost === "node") {
            yield* runtime.auth.controller.invalidate!;
            const closed = yield* Effect.promise(() =>
              readToken(endpoint!).then(
                () => false,
                () => true,
              ),
            );
            assert.isTrue(closed);
          }
        }).pipe(Effect.scoped);
        assert.strictEqual(leases, 0);
        assert.equal(JSON.stringify(ambient), ambientBefore);
        yield* runtime.auth.controller.logout(Effect.void);
        assert.equal(
          yield* fs.readFileString(path.join(sharedHome, "auth.json")),
          "native-auth-unchanged",
        );
        assert.equal(
          yield* fs.readFileString(path.join(sharedHome, "config.toml")),
          "# shared config\n",
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
                ].includes(request.url),
              );
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
