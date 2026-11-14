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
  it.effect("serializes concurrent model preference edits without cancelling duplicate adds", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const provider = ProviderInstanceId.make("codex_work");
      yield* Effect.all(
        [
          service.updateSettings({
            setModelFavorites: [{ provider, model: "sol", favorite: true }],
          }),
          service.updateSettings({
            setModelFavorites: [{ provider, model: "sol", favorite: true }],
          }),
          service.updateSettings({
            setModelFavorites: [{ provider, model: "luna", favorite: true }],
          }),
          service.updateSettings({ setModelsHidden: [{ provider, model: "astra", hidden: true }] }),
          service.updateSettings({ setModelsHidden: [{ provider, model: "luna", hidden: true }] }),
          service.updateSettings({
            setProviderModelOrder: { provider, modelOrder: ["luna", "sol"] },
          }),
        ],
        { concurrency: "unbounded" },
      );
      const settings = yield* service.getSettings;
      assert.deepEqual(settings.favorites?.map((entry) => entry.model).sort(), ["luna", "sol"]);
      assert.deepEqual(settings.providerModelPreferences?.[provider]?.hiddenModels.toSorted(), [
        "astra",
        "luna",
      ]);
      assert.deepEqual(settings.providerModelPreferences?.[provider]?.modelOrder, ["luna", "sol"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("persists and broadcasts model preferences to other connected clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const provider = ProviderInstanceId.make("codex_work");
        const patch = {
          favorites: [{ provider, model: "sol" }],
          providerModelPreferences: {
            [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] },
          },
        };
        const changes = yield* service.subscribeChanges;
        yield* service.updateSettings(patch);
        const received = Option.getOrThrow(yield* Stream.runHead(changes));
        assert.deepEqual(received.favorites, patch.favorites);
        assert.deepEqual(received.providerModelPreferences, patch.providerModelPreferences);
        const saved = yield* decodeServerSettingsJson(
          yield* fs.readFileString(config.settingsPath),
        );
        assert.deepEqual(saved.favorites, patch.favorites);
        assert.deepEqual(saved.providerModelPreferences, patch.providerModelPreferences);
        const hidden = yield* service.updateSettings({
          setModelsHidden: [{ provider, model: "sol", hidden: true }],
        });
        assert.deepEqual(hidden.providerModelPreferences?.[provider], {
          hiddenModels: ["astra", "sol"],
          modelOrder: ["sol"],
        });
        const shown = yield* service.updateSettings({
          setModelsHidden: [{ provider, model: "astra", hidden: false }],
        });
        assert.deepEqual(shown.providerModelPreferences?.[provider], {
          hiddenModels: ["sol"],
          modelOrder: ["sol"],
        });
        assert.deepEqual(
          (yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath)))
            .providerModelPreferences,
          shown.providerModelPreferences,
        );
        yield* service.updateSettings({ favorites: [], providerModelPreferences: {} });

        const migrated = yield* service.updateSettings({ migrateModelPreferences: patch });
        assert.deepEqual(migrated.favorites, []);
        assert.deepEqual(migrated.providerModelPreferences, {});
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("migrates saved token delivery to paragraph buffering without resetting settings", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        `{
          "responseStreamingMode": "token",
          "enableAgentBrowserAccess": false,
          "projectSettingsOverrides": {
            "legacy": { "responseStreamingMode": "token", "defaultAutoPull": true },
            "buffered": { "responseStreamingMode": "turn" },
            "inherited": { "defaultAutoPull": false }
          }
        }`,
      );

      const settings = yield* service.getSettings;
      assert.equal(settings.responseStreamingMode, "paragraph");
      assert.isFalse(settings.enableAgentBrowserAccess);
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("legacy")]: { responseStreamingMode: "paragraph", defaultAutoPull: true },
        [ProjectId.make("buffered")]: { responseStreamingMode: "turn" },
        [ProjectId.make("inherited")]: { defaultAutoPull: false },
      });

      yield* service.updateSettings({ responseStreamingMode: "turn" });
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "turn");
      assert.deepEqual(persisted.projectSettingsOverrides, settings.projectSettingsOverrides);
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("keeps an override key a newer server saved when a project setting is edited", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const projectId = ProjectId.make("project-a");
      yield* fs.writeFileString(
        config.settingsPath,
        `{ "projectSettingsOverrides": { "project-a": { "defaultAutoPull": true, "addedByNewerServer": 3 } } }`,
      );
      const loaded = yield* service.getSettings;

      yield* service.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { ...loaded.projectSettingsOverrides[projectId], defaultAutoPull: false },
        },
      });

      const persisted = JSON.parse(yield* fs.readFileString(config.settingsPath));
      assert.deepEqual(persisted.projectSettingsOverrides, {
        [projectId]: { defaultAutoPull: false, addedByNewerServer: 3 },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("moves an idle compaction mode saved in the legacy switch to its own field", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(config.settingsPath, `{ "compactIdleThreads": "off" }`);

      const settings = yield* service.getSettings;
      // Shipped clients decode the switch as a boolean and drop the config otherwise.
      assert.strictEqual(settings.compactIdleThreads, false);
      assert.equal(settings.idleCompaction, "off");
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("tells clients it reads idle compaction modes before any settings are saved", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const settings = yield* service.getSettings;
      assert.equal(settings.idleCompaction, "onReturn");
      assert.strictEqual(settings.compactIdleThreads, false);
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("sends clients a known secret provider's config but never an unknown kind's", () =>
    Effect.gen(function* () {
      const settings = yield* decodeServerSettings({
        secretProviders: {
          personal: { kind: "one_password", label: "Personal", config: { account: "my" } },
          vault: { kind: "openbao", label: "Vault", config: { token: "bao-token" } },
        },
      });
      assert.deepStrictEqual<unknown>(
        ServerSettingsModule.redactServerSettingsForClient(settings, { secretReferences: true })
          .secretProviders,
        {
          personal: { kind: "one_password", label: "Personal", config: { account: "my" } },
          vault: { kind: "openbao", label: "Vault" },
        },
      );
    }),
  );
  it.effect("stores no secret provider of an unloaded kind or with a config its kind rejects", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const write = (entry: unknown) =>
        decodeServerSettingsPatch({ secretProviders: { personal: entry } }).pipe(
          Effect.flatMap(service.updateSettings),
          Effect.flip,
        );
      for (const entry of [
        { kind: "one_password", label: "Personal", config: { account: "--help" } },
        { kind: "one_password", label: "Personal" },
        { kind: "openbao", label: "Vault", config: { address: "https://x" } },
      ]) {
        assert.deepInclude(yield* write(entry), { operation: "write-secret-provider" });
      }
      assert.deepStrictEqual((yield* service.getSettings).secretProviders, {});
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("saves through a symlinked settings file without replacing the link", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
      const linkedSettingsPath = path.join(dotfiles, "settings.json");
      yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
      yield* fs.remove(config.settingsPath, { force: true });
      yield* fs.symlink(linkedSettingsPath, config.settingsPath);

      yield* service.updateSettings({ responseStreamingMode: "paragraph" });

      assert.equal(yield* fs.readLink(config.settingsPath), linkedSettingsPath);
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(linkedSettingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "paragraph");
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("retries a failed settings read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* fileSystem.makeDirectory(serverConfig.settingsPath);

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.deepInclude(error, { _tag: "ServerSettingsError", operation: "read-file" });

      yield* fileSystem.remove(serverConfig.settingsPath, { recursive: true });
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{ "responseStreamingMode": "turn" }`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.equal(settings.responseStreamingMode, "turn");
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );
  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        observability: { otlpMetricsUrl: "http://localhost:4318/v1/metrics" },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.equal(next.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
      assert.equal(next.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("keeps an external settings edit that the watcher has not reloaded yet", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.getSettings;

      yield* writeFileStringAtomically({
        filePath: config.settingsPath,
        contents: `{ "responseStreamingMode": "turn" }`,
      });
      yield* serverSettings.updateSettings({
        observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
      });

      const saved = yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath));
      assert.equal(saved.responseStreamingMode, "turn");
      assert.equal(saved.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");

      yield* writeFileStringAtomically({
        filePath: config.settingsPath,
        contents: `{ "responseStreamingMode": "paragraph" }`,
      });
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "Kilo",
          config: { agentId: "kilo", distribution: "auto" },
        },
      });

      const afterProviderSave = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(afterProviderSave.responseStreamingMode, "paragraph");
      assert.equal(afterProviderSave.providerInstances[instanceId]?.displayName, "Kilo");
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("refuses to save over a settings file it cannot parse", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.getSettings;
      const raw = `{ "responseStreamingMode": "turn", `;
      yield* fs.writeFileString(config.settingsPath, raw);

      const error = yield* Effect.flip(
        serverSettings.updateSettings({
          observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        }),
      );

      assert.equal(error.operation, "read-file");
      assert.equal(error.settingsPath, config.settingsPath);
      assert.instanceOf(error.cause, Error);
      assert.equal(yield* fs.readFileString(config.settingsPath), raw);
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("creates provider instances atomically without overwriting a concurrent add", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("acpRegistry_shared");
      const results = yield* Effect.forEach(
        ["First", "Second"],
        (displayName) =>
          serverSettings
            .updateProviderInstance({
              operation: "create",
              instanceId,
              instance: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName,
                config: { agentId: "shared", distribution: "auto" },
              },
            })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
      assert.isTrue(
        ["First", "Second"].includes(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName ?? "",
        ),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("pauses provider-instance mutations while a settings snapshot is in use", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const snapshotEntered = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const mutationCompleted = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");

      const snapshotFiber = yield* serverSettings
        .withSettingsSnapshot(() =>
          Deferred.succeed(snapshotEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSnapshot)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(snapshotEntered);

      const mutationFiber = yield* serverSettings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Kilo",
            config: { agentId: "kilo", distribution: "auto" },
          },
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(mutationCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;

      assert.isTrue(Option.isNone(yield* Deferred.poll(mutationCompleted)));
      yield* Deferred.succeed(releaseSnapshot, undefined);
      yield* Fiber.join(snapshotFiber);
      yield* Fiber.join(mutationFiber);
      assert.equal(
        (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName,
        "Kilo",
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          addProjectBaseDirectory: "~/next",
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(Option.getOrUndefined(firstChange)?.addProjectBaseDirectory, "~/next");
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("preserves saved usage settings during cleanup edits and removes custom prices", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const prices = {
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8,
          cacheReadCostPerMillionTokens: 0,
        };
        const readPersisted = fileSystem
          .readFileString(serverConfig.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))));

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": prices } });
        const usageModelAliases = { "example-preview": "example-model" };
        const sourceId = UsageLimitSourceId.make("hub");
        const usageLimitSources = {
          [sourceId]: {
            kind: "cliproxy" as const,
            url: "https://hub.example.test",
            managementKey: "",
            enabled: true,
          },
        };
        const saved = yield* serverSettings.updateSettings({
          usageModelAliases,
          usageLimitSources,
        });
        const updated = yield* serverSettings.updateSettings({
          storageCleanup: { worktreeSettledAfterDays: 0, worktreeKeepWhen: "any-local-files" },
        });
        assert.deepStrictEqual(updated.usageLimitSources, saved.usageLimitSources);
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });
        assert.deepStrictEqual(persisted.usageModelAliases, usageModelAliases);
        assert.deepStrictEqual(persisted.usageLimitSources, usageLimitSources);
        assert.equal(persisted.storageCleanup.worktreeSettledAfterDays, 0);
        assert.equal(persisted.storageCleanup.worktreeKeepWhen, "any-local-files");

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect(
    "keeps a custom instance's selection when the driver's default instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(layerServerSettings())),
  );




















  // A backend behind a custom model may refuse the built-in default.























});
