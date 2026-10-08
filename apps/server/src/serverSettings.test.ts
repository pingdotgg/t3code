import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

/** Like `layerServerSettings`, but also exposes the secret store for assertions. */
const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const layerFailingSecretStore = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

it.layer(NodeServices.layer)("server settings", (it) => {
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

  it.effect("reloads when the destination of a symlinked settings file changes", () =>
    Effect.scoped(
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
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeFileStringAtomically({
          filePath: linkedSettingsPath,
          contents: `{ "responseStreamingMode": "paragraph" }`,
        });

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("follows a settings link that is repointed to another directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const firstSettingsPath = path.join(dotfiles, "first", "settings.json");
        const secondSettingsPath = path.join(dotfiles, "second", "settings.json");
        yield* fs.makeDirectory(path.dirname(firstSettingsPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(secondSettingsPath), { recursive: true });
        yield* fs.writeFileString(firstSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.writeFileString(secondSettingsPath, `{ "responseStreamingMode": "paragraph" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(firstSettingsPath, config.settingsPath);
        yield* service.start;

        const repointChanges = yield* service.subscribeChanges;
        yield* fs.remove(config.settingsPath);
        yield* fs.symlink(secondSettingsPath, config.settingsPath);
        const repointed = yield* repointChanges.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(repointed)?.responseStreamingMode, "paragraph");

        const editChanges = yield* service.subscribeChanges;
        yield* writeFileStringAtomically({
          filePath: secondSettingsPath,
          contents: `{ "responseStreamingMode": "turn" }`,
        });
        const edited = yield* editChanges.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(edited)?.responseStreamingMode, "turn");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("reloads when a dangling settings link gets its destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "not-yet", "settings.json");
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeFileStringAtomically({
          filePath: linkedSettingsPath,
          contents: `{ "responseStreamingMode": "paragraph" }`,
        });

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const layerConfig = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerFailingSecretStore(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(layerConfig),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect("identifies provider history query failures", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_thread_sessions`;

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-provider-history",
        settingsPath: serverConfig.settingsPath,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("retries a failed settings read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // A directory where the file should be makes the read itself fail.
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

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
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

  it.effect("creates provider instances atomically without overwriting a concurrent add", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("acpRegistry_shared");
      const results = yield* Effect.all(
        ["First", "Second"].map((displayName) =>
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
        ),
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

  it.effect("persists custom usage prices and removes them from the settings file", () =>
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
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("persists and broadcasts thread settlement settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        const next = yield* serverSettings.updateSettings({
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
        });
        const change = Option.getOrUndefined(yield* Stream.runHead(changes));
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        // Inspect raw persisted JSON before schema decoding can apply defaults.
        const persisted = JSON.parse(raw) as Record<string, unknown>;

        assert.strictEqual(next.sidebarAutoSettleAfterDays, null);
        assert.isFalse(next.sidebarAutoSettleOnMerge);
        assert.strictEqual(change?.sidebarAutoSettleAfterDays, null);
        assert.isFalse(change?.sidebarAutoSettleOnMerge);
        assert.strictEqual(persisted.sidebarAutoSettleAfterDays, null);
        assert.isFalse(persisted.sidebarAutoSettleOnMerge);
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      // Start with Claude text generation selection
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

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
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

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
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

  // Only driver-keyed instances are fallback candidates; a custom instance id
  // is not one, so the selection stays put until the user changes it.
  it.effect.each(["codex"])(
    "falls back to enabled instance %s after disabling the selection",
    (fallbackId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
          const serverConfig = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const writerId = ProviderInstanceId.make("writer");
          const fallbackInstanceId = ProviderInstanceId.make(fallbackId);
          const selection = { instanceId: writerId, model: "claude-sonnet-4-6" };
          const providerInstances = {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [fallbackInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [writerId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: {},
            },
          };

          yield* serverSettings.updateSettings({
            providerInstances,
            textGenerationModelSelection: selection,
          });
          const changes = yield* serverSettings.subscribeChanges;

          const next = yield* serverSettings.updateSettings({
            providerInstances: {
              ...providerInstances,
              [writerId]: { ...providerInstances[writerId]!, enabled: false },
            },
          });
          const fallbackSelection = {
            instanceId: fallbackInstanceId,
            model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          };
          assert.deepEqual(next.textGenerationModelSelection, fallbackSelection);
          assert.deepEqual(
            (yield* serverSettings.getSettings).textGenerationModelSelection,
            fallbackSelection,
          );
          const change = Option.getOrUndefined(yield* Stream.runHead(changes));
          assert.deepEqual(change?.textGenerationModelSelection, fallbackSelection);

          const persisted = yield* fileSystem
            .readFileString(serverConfig.settingsPath)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))),
            );
          assert.deepEqual(persisted.textGenerationModelSelection, selection);

          const restored = yield* serverSettings.updateSettings({ providerInstances });
          assert.deepEqual(restored.textGenerationModelSelection, selection);
        }),
      ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("skips explicitly disabled default instances when choosing a fallback", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: {},
          },
        },
      });

      assert.equal(next.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
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

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
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
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("moves customized legacy provider settings into default instances on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          addProjectBaseDirectory: "~/Development",
          providers: {
            codex: { binaryPath: "/opt/guard/bin/codex" },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            grok: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances, {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { binaryPath: "/opt/guard/bin/codex" },
        },
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: {},
        },
      });
      // The file is rewritten once: instances persist and the retired map is gone.
      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.equal(persisted.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(persisted.providerInstances.codex, {
        driver: "codex",
        config: { binaryPath: "/opt/guard/bin/codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps an explicit default instance over the legacy blob for its driver", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providers: { codex: { binaryPath: "/legacy/codex" } },
          providerInstances: {
            codex: { driver: "codex", enabled: true, config: { binaryPath: "/explicit/codex" } },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { binaryPath: "/explicit/codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("enables previously used optional providers while migrating legacy settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providers: { opencode: { serverUrl: "http://127.0.0.1:4096" }, cursor: {} },
          providerInstances: {
            cursor_work: { driver: "cursor", config: {} },
            opencode_unused: { driver: "opencode", config: {} },
          },
        }),
      );
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("cursor", "cursor_work");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("opencode")], {
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        config: { serverUrl: "http://127.0.0.1:4096" },
      });
      // Used without any legacy blob or instance: the slot is created enabled.
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);
      // Using any cursor instance counts as opting into the driver.
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps explicit legacy disables even when provider history shows use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({ providers: { grok: { enabled: false, binaryPath: "/opt/grok" } } }),
      );
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("grok")], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("runs provider history only for files that still carry the legacy map", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances, {});
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("migrates legacy providers from an invalid file without rewriting it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const raw = '{"addProjectBaseDirectory":42,"providers":{"codex":{"binaryPath":"/x"}}}';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, raw);

      const settings = yield* serverSettings.getSettings;

      // The readable provider settings still apply, but the file stays for the user to repair.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/x" },
      });
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), raw);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("skips a disabled provider instance when picking the text generation fallback", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps a default-off provider's new instance disabled and sparse on disk", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));
      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.isUndefined(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable sticks.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });
      // A lone in-config flag is lifted to the envelope and stripped.
      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });
      // A malformed flag is left alone so driver schema validation can
      // surface it instead of the fold silently repairing the config.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("writes only non-default settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        backgroundActivity: {
          schemaVersion: 1,
          profile: "custom",
          baseProfile: "balanced",
          overrides: {
            automaticGitFetchInterval: 10_000,
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps the inline value on disk when secret migration fails", () => {
    const cause = new ServerSecretStore.SecretStorePersistError({
      resource: "provider environment secret",
      cause: new Error("Secret storage unavailable"),
    });
    const layerSecret = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerSecret),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-inline-secret-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const original =
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}';
      yield* fs.writeFileString(config.settingsPath, original);
      const error = yield* Effect.flip(
        service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
              config: {},
            },
          },
        }),
      );
      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, cause);
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
      const settings = yield* service.getSettings;
      assert.equal(
        settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect.each(
    [
      {
        label: "preserves an inline secret on a redacted settings save",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "inline-test-token",
      },
      {
        label: "preserves the effective last inline secret when names are duplicated",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "last-inline-test-token",
        duplicate: true,
      },
      {
        label: "replaces an inline secret with an explicit value",
        variable: { name: "API_TOKEN", value: "replacement-test-token", sensitive: true },
        expected: "replacement-test-token",
      },
      {
        label: "clears an inline secret with an explicit empty value",
        variable: { name: "API_TOKEN", value: "", sensitive: true },
        expected: "",
      },
    ].map((testCase) => [testCase.label, testCase] as const),
  )("%s", ([, { variable, expected, duplicate }]) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        duplicate
          ? '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true},{"name":"API_TOKEN","value":"last-inline-test-token","sensitive":true}],"config":{}}}}'
          : '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}',
      );
      const initial = yield* serverSettings.getSettings;
      assert.equal(
        initial.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Renamed provider",
            environment: duplicate ? [variable, variable] : [variable],
            config: {},
          },
        },
      });
      assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, expected);
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "inline-test-token");
      assert.notInclude(raw, "replacement-test-token");

      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );
      assert.equal(reloaded.providerInstances[instanceId]?.environment?.[0]?.value, expected);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect.each([true, false])(
    "preserves duplicate secret operation order (sensitive last: %s)",
    (sensitiveLast) =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_duplicate");
        const secret = { name: "API_TOKEN", value: "secret-last", sensitive: true };
        const plain = { name: "API_TOKEN", value: "plain-last", sensitive: false };
        const next = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: sensitiveLast ? [plain, secret] : [secret, plain],
              config: {},
            },
          },
        });
        assert.equal(
          next.providerInstances[instanceId]?.environment?.at(-1)?.value,
          sensitiveLast ? "secret-last" : "plain-last",
        );
        assert.equal(
          next.providerInstances[instanceId]?.environment?.find((v) => v.sensitive)?.value,
          sensitiveLast ? "secret-last" : "",
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "keeps Bitbucket tokens in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          bitbucket: { email: "me@example.com", accessToken: "bb-access", apiToken: "bb-api" },
        });
        assert.deepEqual(saved.bitbucket, {
          email: "me@example.com",
          accessToken: "bb-access",
          apiToken: "bb-api",
        });

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "bb-access");
        assert.notInclude(raw, "bb-api");
        assert.include(raw, "me@example.com");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).bitbucket;
        assert.equal(forClient.email, "me@example.com");
        assert.notInclude(forClient.accessToken, "bb-access");
        assert.notInclude(forClient.apiToken, "bb-api");
        assert.isAbove(forClient.accessToken.length, 0);
        assert.isAbove(forClient.apiToken.length, 0);

        // A client echoing the redacted values back, or omitting them, keeps the saved tokens.
        yield* serverSettings.updateSettings({ bitbucket: forClient });
        yield* serverSettings.updateSettings({ bitbucket: { email: "other@example.com" } });
        assert.deepEqual((yield* serverSettings.getSettings).bitbucket, {
          email: "other@example.com",
          accessToken: "bb-access",
          apiToken: "bb-api",
        });

        const cleared = yield* serverSettings.updateSettings({ bitbucket: { accessToken: "" } });
        assert.equal(cleared.bitbucket.accessToken, "");
        assert.equal(cleared.bitbucket.apiToken, "bb-api");
        assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
        assert.equal(
          ServerSettingsModule.redactServerSettingsForClient(cleared).bitbucket.accessToken,
          "",
        );
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "keeps GitHub tokens per host in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          github: { tokens: { "GitHub.com": "ghp_dotcom", "ghe.acme.test": "ghp_ghe" } },
        });
        assert.deepEqual(saved.github.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "ghp_dotcom");
        assert.notInclude(raw, "ghp_ghe");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).github;
        assert.notInclude(forClient.tokens["github.com"]!, "ghp_dotcom");
        assert.isAbove(forClient.tokens["github.com"]!.length, 0);

        // Echoing the redacted values back keeps them; host and account changes leave tokens alone.
        yield* serverSettings.updateSettings({ github: { tokens: forClient.tokens } });
        yield* serverSettings.updateSettings({
          github: { hosts: { "github.com": { enabled: true, account: "work" } } },
        });
        assert.deepEqual((yield* serverSettings.getSettings).github.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });

        // An empty token removes that host's token and nothing else.
        const cleared = yield* serverSettings.updateSettings({
          github: { tokens: { "github.com": "" } },
        });
        assert.equal(cleared.github.tokens["github.com"] ?? "", "");
        assert.equal(cleared.github.tokens["ghe.acme.test"], "ghp_ghe");
        const remaining = yield* Effect.forEach(["github.com", "ghe.acme.test"], (host) =>
          secrets.get(`github-token-${Buffer.from(host, "utf8").toString("base64url")}`),
        );
        assert.isTrue(Option.isNone(remaining[0]!));
        assert.isTrue(Option.isSome(remaining[1]!));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("removes a Bitbucket secret once its token is cleared by hand in settings.json", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // A token was saved, then the user deleted it from settings.json directly.
      yield* secrets.set("bitbucket-access-token", new TextEncoder().encode("stale-token"));
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      yield* serverSettings.updateSettings({ cursorKeychainUsageEnabled: true });

      assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("moves a hand-edited Bitbucket token into the secret store when settings load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"bitbucket":{"accessToken":"hand-edited-token"}}',
      );

      // Loading alone moves it: no settings update is needed.
      const loaded = yield* serverSettings.getSettings;

      assert.equal(loaded.bitbucket.accessToken, "hand-edited-token");
      assert.notInclude(
        yield* fileSystem.readFileString(serverConfig.settingsPath),
        "hand-edited-token",
      );
      const stored = yield* secrets.get("bitbucket-access-token");
      assert.equal(
        Option.isSome(stored) ? new TextDecoder().decode(stored.value) : null,
        "hand-edited-token",
      );
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "moves a hand-edited Bitbucket token into the secret store when a client echoes the marker",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          '{"bitbucket":{"email":"me@example.com","apiToken":"hand-edited-token"}}',
        );

        // The form resends the redacted token when only the email changes.
        const forClient = ServerSettingsModule.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        ).bitbucket;
        const updated = yield* serverSettings.updateSettings({
          bitbucket: { email: "new@example.com", apiToken: forClient.apiToken },
        });

        assert.equal(updated.bitbucket.apiToken, "hand-edited-token");
        assert.equal((yield* serverSettings.getSettings).bitbucket.apiToken, "hand-edited-token");
        assert.notInclude(
          yield* fileSystem.readFileString(serverConfig.settingsPath),
          "hand-edited-token",
        );
      }).pipe(Effect.provide(layerServerSettings())),
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
            ? Effect.fail(writeFailure)
            : fileSystem.rename(fromPath, toPath),
      });
      const instanceId = ProviderInstanceId.make("codex_write_failure");
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
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
            config: {},
          },
        });

        failRename = true;
        const failedUpdate = yield* serverSettings
          .updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
              config: {},
            },
          })
          .pipe(Effect.result);
        assert.equal(failedUpdate._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
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
      }).pipe(Effect.provide(layerSettings));
    }),
  );

  it.effect.each(["response materialization", "partially committed write"] as const)(
    "rolls back provider secret changes after %s fails",
    (failure) => {
      const textDecoder = new TextDecoder();
      const secrets = new Map<string, Uint8Array>();
      let rejectNewSecret = false;
      const layerSecretStore = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.suspend(() => {
              const value = secrets.get(name);
              if (
                failure === "response materialization" &&
                rejectNewSecret &&
                value !== undefined &&
                textDecoder.decode(value) === "sk-new"
              ) {
                return Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: `secret ${name}`,
                    cause: "Forced response materialization failure.",
                  }),
                );
              }
              return Effect.succeed(
                value === undefined ? Option.none() : Option.some(Uint8Array.from(value)),
              );
            }),
          set: (name, value) =>
            Effect.suspend(() => {
              secrets.set(name, Uint8Array.from(value));
              return failure === "partially committed write" &&
                rejectNewSecret &&
                textDecoder.decode(value) === "sk-new"
                ? Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: `secret ${name}`,
                      cause: "chmod failed after rename",
                    }),
                  )
                : Effect.void;
            }),
          create: (name, value) =>
            Effect.sync(() => {
              secrets.set(name, Uint8Array.from(value));
            }),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const value = secrets.get(name) ?? new Uint8Array(bytes);
              secrets.set(name, value);
              return Uint8Array.from(value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              secrets.delete(name);
            }),
        }),
      );
      const layerSettings = ServerSettingsModule.layer.pipe(
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(layerSecretStore),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3code-server-settings-materialization-failure-test-",
            }),
          ),
        ),
      );
      const instanceId = ProviderInstanceId.make("codex_materialization_failure");

      return Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: {},
            },
          },
        });

        rejectNewSecret = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: {},
              },
            },
          })
          .pipe(Effect.result);

        assert.equal(failedUpdate._tag, "Failure");
        rejectNewSecret = false;
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    },
  );

  it.effect("folds legacy project overrides into projectSettingsOverrides once", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacyProject = ProjectId.make("project-legacy");
      const scriptedProject = ProjectId.make("project-scripted");
      const script: ProjectScript = {
        id: "check",
        name: "Check",
        command: "npm test",
        icon: "play",
        runOnWorktreeCreate: false,
      };
      const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
      const modelJson = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
      const scriptsJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(ProjectScript)),
      )([script]);
      for (const [projectId, modelColumn, envMode, autoPull, scripts] of [
        // The legacy project also carries aggregate scripts, but its stored
        // null override reset them; the fold must not bring them back.
        [legacyProject, modelJson, "worktree", 1, scriptsJson],
        [scriptedProject, null, null, 0, scriptsJson],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${modelColumn},
            ${envMode}, ${autoPull}, ${scripts},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{"projectAgentBrowserAccessOverrides":{"${legacyProject}":false},"projectAutoPullOverrides":{"${scriptedProject}":true},"projectScriptOverrides":{"${legacyProject}":null}}`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.projectSettingsFolded);
      assert.deepEqual<ServerSettings["projectSettingsOverrides"]>(
        settings.projectSettingsOverrides,
        {
          [legacyProject]: {
            enableAgentBrowserAccess: false,
            defaultModelSelection: model,
            defaultThreadEnvMode: "worktree",
            defaultAutoPull: true,
          },
          [scriptedProject]: { defaultAutoPull: true, defaultProjectScripts: [script] },
        },
      );
      // Derived legacy views keep older clients reading the same values.
      assert.deepEqual<ServerSettings["projectAutoPullOverrides"]>(
        settings.projectAutoPullOverrides,
        {
          [legacyProject]: true,
          [scriptedProject]: true,
        },
      );
      assert.deepEqual<ServerSettings["projectScriptOverrides"]>(settings.projectScriptOverrides, {
        [scriptedProject]: [script],
      });

      // A reset survives the next load: the fold does not run again.
      yield* serverSettings.updateSettings({
        projectSettingsOverrides: { [legacyProject]: null },
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodeServerSettings(JSON.parse(raw));
      assert.isTrue(persisted.projectSettingsFolded);
      assert.isUndefined(persisted.projectSettingsOverrides[legacyProject]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("leaves an unreadable settings.json untouched instead of folding over it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at
        )
        VALUES (
          ${"project-broken"}, ${"Project"}, ${"/tmp/project-broken"}, ${1}, ${"[]"},
          ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
        )
      `;
      const broken = '{"defaultAutoPull": tru';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, broken);

      const settings = yield* serverSettings.getSettings;
      assert.isFalse(settings.projectSettingsFolded);
      assert.deepEqual(settings.projectSettingsOverrides, {});
      // The user's file is still there to repair; nothing was written over it.
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), broken);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
