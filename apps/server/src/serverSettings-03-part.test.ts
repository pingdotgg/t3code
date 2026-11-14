import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  type ManagedPolicyDocument,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  SecretProviderId,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SchemaAST from "effect/SchemaAST";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { sourceControlHostSecretName } from "./sourceControl/sourceControlHostSecrets.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerSettingsModule from "./serverSettings.ts";
import { SECRET_REDACTED } from "./settingsSecrets.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

/** Paths of fields typed `SettingsSecretValue` that clients decode with the settings schema itself. */



import { decodeServerSettings, decodeServerSettingsJson, decodeServerSettingsPatch, layerServerSettings, layerServerSettingsWithSecrets, layerFailingSecretStore, recordProviderUsage, strictSecretReferencePaths } from "./serverSettings-fixtures.testkit.ts";
it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("server settings", (it) => {
  it.effect(
    "uses the same secret lifecycle for provider config, environment, host tokens, and quota keys",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const instanceId = ProviderInstanceId.make("antigravity_secrets");
        const saved = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              config: { apiKey: "config-secret" },
              environment: [
                { name: "API_TOKEN", value: "env-secret", sensitive: true },
                { name: "BASE_URL", value: "https://example.test", sensitive: false },
              ],
            },
          },
          sourceControlHosts: {
            github: { tokens: { "github.com": "github-secret" } },
            bitbucket: { email: "me@example.test", accessToken: "bitbucket-secret" },
            gitcafe: { token: "gitcafe-secret" },
          },
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.example.test",
              managementKey: "quota-secret",
              enabled: true,
            },
          },
          easDeviceHosts: [
            {
              kind: "eas",
              id: "eas",
              label: "EAS Simulator",
              accessToken: "expo-secret",
              maxSessionMinutes: 30,
              idleMinutes: 10,
              maxConcurrentSessions: 2,
            },
          ],
        });
        const values = [
          "config-secret",
          "env-secret",
          "github-secret",
          "bitbucket-secret",
          "gitcafe-secret",
          "quota-secret",
          "expo-secret",
        ];
        const client = ServerSettingsModule.redactServerSettingsForClient(saved, {
          secretReferences: true,
        });
        const disk = yield* fs.readFileString(config.settingsPath);
        for (const value of values) {
          assert.include(JSON.stringify(saved), value);
          assert.notInclude(JSON.stringify(client), value);
          assert.notInclude(disk, value);
        }
        assert.include(JSON.stringify(client), "https://example.test");
        assert.include(JSON.stringify(client), "me@example.test");
        const echoed = yield* service.updateSettings({
          providerInstances: client.providerInstances,
          sourceControlHosts: client.sourceControlHosts,
          usageLimitSources: client.usageLimitSources,
          easDeviceHosts: client.easDeviceHosts,
        });
        for (const value of values) assert.include(JSON.stringify(echoed), value);
        const renamed = yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: { ...client.providerInstances[instanceId]!, displayName: "Renamed" },
        });
        assert.propertyVal(
          renamed.providerInstances[instanceId]?.config,
          "apiKey",
          "config-secret",
        );

        for (const apiKey of ["replacement-secret", ""]) {
          const changed = yield* service.updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: { ...client.providerInstances[instanceId]!, config: { apiKey } },
          });
          assert.propertyVal(changed.providerInstances[instanceId]?.config, "apiKey", apiKey);
          const redacted = ServerSettingsModule.redactServerSettingsForClient(changed, {
            secretReferences: true,
          });
          assert.propertyVal(
            redacted.providerInstances[instanceId]?.config,
            "apiKey",
            apiKey ? "••••••" : "",
          );
        }

        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: saved.providerInstances[instanceId]!,
        });

        const secretNames = [
          "provider-config-YW50aWdyYXZpdHlfc2VjcmV0cw-YW50aWdyYXZpdHk-YXBpS2V5",
          "provider-env-YW50aWdyYXZpdHlfc2VjcmV0cw-QVBJX1RPS0VO",
          sourceControlHostSecretName({
            kind: "github",
            field: "tokens",
            serverHost: "github.com",
          }),
          sourceControlHostSecretName({
            kind: "bitbucket",
            field: "accessToken",
            serverHost: null,
          }),
          sourceControlHostSecretName({ kind: "gitcafe", field: "token", serverHost: null }),
          "usage-limit-source-aHVi",
        ];
        for (const name of secretNames) {
          assert.isTrue(Option.isSome(yield* store.get(name)), name);
        }
        const secret = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/Antigravity/token",
        };
        const referenced = yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...client.providerInstances[instanceId]!,
            environment: [
              { name: "API_TOKEN", value: secret, sensitive: true, valueRedacted: true },
            ],
          },
        });
        assert.isTrue(Option.isNone(yield* store.get(secretNames[1]!)));
        assert.deepEqual(
          ServerSettingsModule.redactServerSettingsForClient(referenced, { secretReferences: true })
            .providerInstances[instanceId]?.environment,
          [{ name: "API_TOKEN", value: secret, sensitive: true }],
        );
        yield* service.updateSettings({
          providerInstances: {},
          sourceControlHosts: {
            github: { tokens: {} },
            bitbucket: { accessToken: "" },
            gitcafe: { token: "" },
          },
          usageLimitSources: { [UsageLimitSourceId.make("hub")]: null },
        });
        for (const name of secretNames) {
          assert.isTrue(Option.isNone(yield* store.get(name)));
        }
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
  it.effect("moves saved provider credentials to the secret store when settings load", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providerInstances: {
            antigravity: { driver: "antigravity", config: { apiKey: "legacy-api-key" } },
            opencode: {
              driver: "opencode",
              config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "legacy-password" },
            },
          },
        }),
      );
      const saved = yield* service.getSettings;
      const opencode = ProviderInstanceId.make("opencode");
      assert.propertyVal(
        saved.providerInstances[ProviderInstanceId.make("antigravity")]?.config,
        "apiKey",
        "legacy-api-key",
      );
      assert.propertyVal(
        saved.providerInstances[opencode]?.config,
        "serverPassword",
        "legacy-password",
      );
      const client = ServerSettingsModule.redactServerSettingsForClient(saved, {
        secretReferences: true,
      });
      for (const value of ["legacy-api-key", "legacy-password"]) {
        assert.notInclude(yield* fs.readFileString(config.settingsPath), value);
        assert.notInclude(JSON.stringify(client), value);
      }
      const clientConfig = client.providerInstances[opencode]?.config as Record<string, unknown>;
      const edited = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: opencode,
        instance: {
          ...client.providerInstances[opencode]!,
          config: { ...clientConfig, serverUrl: "http://127.0.0.1:4097" },
        },
      });
      assert.deepInclude(edited.providerInstances[opencode]?.config, {
        serverUrl: "http://127.0.0.1:4097",
        serverPassword: "legacy-password",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect(
    "keeps source control host secrets in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          sourceControlHosts: {
            bitbucket: { email: "me@example.com", accessToken: "bb-access" },
            github: { tokens: { "github.com": "ghp_dotcom", "ghe.acme.test": "ghp_ghe" } },
          },
        });
        assert.deepEqual(saved.sourceControlHosts.bitbucket, {
          email: "me@example.com",
          accessToken: "bb-access",
        });
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        for (const secret of ["bb-access", "ghp_dotcom", "ghp_ghe"]) assert.notInclude(raw, secret);
        assert.include(raw, "me@example.com");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved, {
          secretReferences: true,
        }).sourceControlHosts;
        assert.equal(forClient.bitbucket?.email, "me@example.com");
        assert.notInclude(String(forClient.bitbucket?.accessToken), "bb-access");
        assert.isAbove(String(forClient.bitbucket?.accessToken).length, 0);

        yield* serverSettings.updateSettings({ sourceControlHosts: forClient });
        yield* serverSettings.updateSettings({
          sourceControlHosts: { bitbucket: { email: "other@example.com" } },
        });
        const kept = (yield* serverSettings.getSettings).sourceControlHosts;
        assert.deepEqual(kept.bitbucket, { email: "other@example.com", accessToken: "bb-access" });
        assert.deepEqual(kept.github?.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });

        const cleared = yield* serverSettings.updateSettings({
          sourceControlHosts: {
            bitbucket: { accessToken: "" },
            github: {
              tokens: {
                "github.com": "",
                "ghe.acme.test": (forClient.github!.tokens as Record<string, string>)[
                  "ghe.acme.test"
                ],
              },
            },
          },
        });
        assert.equal(cleared.sourceControlHosts.bitbucket?.accessToken, "");
        const stored = (kind: string, field: string, serverHost: string | null) =>
          secrets.get(sourceControlHostSecretName({ kind, field, serverHost }));
        assert.isTrue(Option.isNone(yield* stored("bitbucket", "accessToken", null)));
        assert.isTrue(Option.isNone(yield* stored("github", "tokens", "github.com")));
        assert.isTrue(Option.isSome(yield* stored("github", "tokens", "ghe.acme.test")));

        const reference = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/Bitbucket/token",
        };
        const gitHubReference = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/GitHub/token",
        };
        yield* serverSettings.updateSettings({
          sourceControlHosts: {
            bitbucket: { accessToken: "bb-access" },
            github: { tokens: { "github.com": "ghp_dotcom", "ghe.acme.test": "ghp_ghe" } },
          },
        });
        assert.isTrue(Option.isSome(yield* stored("bitbucket", "accessToken", null)));
        assert.isTrue(Option.isSome(yield* stored("github", "tokens", "github.com")));
        const referenced = yield* serverSettings.updateSettings({
          sourceControlHosts: {
            bitbucket: { accessToken: reference },
            github: { tokens: { "github.com": gitHubReference, "ghe.acme.test": "ghp_ghe" } },
          },
        });
        assert.deepEqual(referenced.sourceControlHosts.bitbucket?.accessToken, reference);
        assert.isTrue(Option.isNone(yield* stored("bitbucket", "accessToken", null)));
        assert.isTrue(Option.isNone(yield* stored("github", "tokens", "github.com")));
        assert.isTrue(Option.isSome(yield* stored("github", "tokens", "ghe.acme.test")));
        const redacted = ServerSettingsModule.redactServerSettingsForClient(referenced, {
          secretReferences: true,
        }).sourceControlHosts;
        assert.deepEqual(redacted.bitbucket?.accessToken, reference);
        const tokens = redacted.github?.tokens as Record<string, unknown>;
        assert.deepEqual(tokens["github.com"], gitHubReference);
        assert.notEqual(tokens["ghe.acme.test"], "ghp_ghe");

        // A client that cannot decode references sees saved secrets and can send them back.
        const usageReference = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/Hub/key",
        };
        const easReference = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Private/Expo/token",
        };
        const hub = UsageLimitSourceId.make("hub");
        const withUsage = yield* serverSettings.updateSettings({
          usageLimitSources: {
            [hub]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: usageReference,
              enabled: true,
            },
          },
          easDeviceHosts: [
            {
              kind: "eas",
              id: "eas",
              label: "EAS Simulator",
              accessToken: easReference,
              maxSessionMinutes: 30,
              idleMinutes: 10,
              maxConcurrentSessions: 2,
            },
          ],
        });
        const legacy = ServerSettingsModule.redactServerSettingsForClient(withUsage, {
          secretReferences: false,
        });
        assert.notInclude(JSON.stringify(legacy), "op://");
        assert.equal(legacy.sourceControlHosts.bitbucket?.accessToken, SECRET_REDACTED);
        assert.equal(legacy.usageLimitSources[hub]?.managementKey, SECRET_REDACTED);
        assert.equal(legacy.easDeviceHosts[0]?.accessToken, SECRET_REDACTED);
        const echoed = yield* serverSettings.updateSettings({
          sourceControlHosts: legacy.sourceControlHosts,
          usageLimitSources: legacy.usageLimitSources,
          easDeviceHosts: legacy.easDeviceHosts,
        });
        assert.deepEqual(echoed.sourceControlHosts.bitbucket?.accessToken, reference);
        assert.deepEqual(echoed.sourceControlHosts.github?.tokens, {
          "github.com": gitHubReference,
          "ghe.acme.test": "ghp_ghe",
        });
        assert.deepEqual(echoed.usageLimitSources[hub]?.managementKey, usageReference);
        assert.deepEqual(echoed.easDeviceHosts[0]?.accessToken, easReference);
        assert.isTrue(Option.isSome(yield* stored("github", "tokens", "ghe.acme.test")));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
  it.effect("knows every strictly decoded field that can hold a secret reference", () =>
    Effect.sync(() => {
      // Shipped clients decode these as strings. Each must be covered by the older-client case above.
      assert.deepEqual(strictSecretReferencePaths(ServerSettings.ast), [
        "easDeviceHosts.[].accessToken",
        "usageLimitSources.*.managementKey",
      ]);
    }),
  );
  it.effect("keeps the retired keys for another load when a token cannot be copied", () => {
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "bitbucket-access-token",
      cause: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: "bitbucket-access-token",
        description: "Secret backend unavailable.",
      }),
    });
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provide(layerFailingSecretStore(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-server-settings-legacy-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacy = JSON.stringify({
        bitbucket: { email: "me@example.com", accessToken: "\u2022\u2022\u2022\u2022\u2022\u2022" },
      });
      yield* fileSystem.writeFileString(serverConfig.settingsPath, legacy);

      yield* Effect.exit(serverSettings.getSettings);

      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), legacy);
    }).pipe(Effect.provide(layerSettings));
  });
  it.effect("moves the retired bitbucket and github keys and their secrets on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const marker = "\u2022\u2022\u2022\u2022\u2022\u2022";
      yield* secrets.set("bitbucket-access-token", new TextEncoder().encode("bb-saved"));
      yield* secrets.set(
        `github-token-${Buffer.from("github.com", "utf8").toString("base64url")}`,
        new TextEncoder().encode("ghp_saved"),
      );
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          bitbucket: { email: "me@example.com", accessToken: marker },
          github: {
            hosts: { "github.com": { account: "work" } },
            tokens: { "github.com": marker },
          },
        }),
      );

      const loaded = (yield* serverSettings.getSettings).sourceControlHosts;

      assert.deepEqual(loaded.bitbucket, { email: "me@example.com", accessToken: "bb-saved" });
      assert.deepEqual(loaded.github?.tokens, { "github.com": "ghp_saved" });
      assert.deepEqual(loaded.github?.hosts, { "github.com": { account: "work" } });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, '"bitbucket":{"email"');
      assert.include(raw, "sourceControlHosts");
      assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
  it.effect(
    "moves a hand-edited source control token into the secret store when settings load",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          '{"sourceControlHosts":{"bitbucket":{"accessToken":"hand-edited-token"}}}',
        );

        const loaded = yield* serverSettings.getSettings;

        assert.equal(loaded.sourceControlHosts.bitbucket?.accessToken, "hand-edited-token");
        assert.notInclude(
          yield* fileSystem.readFileString(serverConfig.settingsPath),
          "hand-edited-token",
        );
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
  it.effect("materializes provider secrets for terminal environment resolution", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("codex_terminal");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-terminal-secret", sensitive: true },
            ],
            config: { homePath: "~/.codex-terminal" },
          },
        },
      });

      const environment = yield* resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: instanceId,
        env: undefined,
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);

      assert.equal(environment.OPENROUTER_API_KEY, "sk-terminal-secret");
      assert.match(environment.CODEX_HOME ?? "", /[\\/][.]codex-terminal$/);
      assert.notInclude(persisted, "sk-terminal-secret");
      assert.include(persisted, '"valueRedacted": true');
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("rolls back provider secret changes when the settings file commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failRename = false;
      let settingsPathToFail: string | undefined;
      let readDuringWrite: Effect.Effect<void> = Effect.void;
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "Forced settings write failure.",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (fromPath, toPath) =>
          failRename && toPath === settingsPathToFail
            ? readDuringWrite.pipe(Effect.andThen(Effect.fail(writeFailure)))
            : fileSystem.rename(fromPath, toPath),
      });
      const instanceId = ProviderInstanceId.make("antigravity_write_failure");
      const layerSettings = layerServerSettings().pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
      );

      yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        settingsPathToFail = (yield* ServerConfig.ServerConfig).settingsPath;
        yield* serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("antigravity"),
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
            config: { apiKey: "config-kept" },
          },
        });

        failRename = true;
        readDuringWrite = Effect.ignore(serverSettings.getSettings);
        const failedUpdate = yield* serverSettings
          .updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("antigravity"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
              config: { apiKey: "config-new" },
            },
          })
          .pipe(Effect.result);
        assert.equal(failedUpdate._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
        assert.propertyVal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.config,
          "apiKey",
          "config-kept",
        );

        const failed = yield* serverSettings
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
        assert.propertyVal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.config,
          "apiKey",
          "config-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    }),
  );




















  // A backend behind a custom model may refuse the built-in default.























});
