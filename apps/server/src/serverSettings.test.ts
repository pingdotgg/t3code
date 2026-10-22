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
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { sourceControlHostSecretName } from "./sourceControl/sourceControlHostSecrets.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerSettingsModule from "./serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

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

type SettingsFileHook = <A>(
  access: Effect.Effect<A, PlatformError.PlatformError>,
) => Effect.Effect<A, PlatformError.PlatformError>;

// Runs the service's reads of settings.json, and the renames that replace it, through hooks, so
// a test can tell when the watcher has reloaded the file or hold a reload open.
const layerServerSettingsAroundFile = (hooks: {
  readonly read?: SettingsFileHook;
  readonly replace?: SettingsFileHook;
}) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { settingsPath } = yield* ServerConfig.ServerConfig;
          const read = hooks.read ?? ((access) => access);
          const replace = hooks.replace ?? ((access) => access);
          return FileSystem.FileSystem.of({
            ...fs,
            readFileString: (filePath, encoding) =>
              filePath === settingsPath
                ? read(fs.readFileString(filePath, encoding))
                : fs.readFileString(filePath, encoding),
            rename: (oldPath, newPath) =>
              path.resolve(newPath) === path.resolve(settingsPath)
                ? replace(fs.rename(oldPath, newPath))
                : fs.rename(oldPath, newPath),
          });
        }),
      ),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const layerServerSettingsReportingReads = (reads: Queue.Queue<void>) =>
  layerServerSettingsAroundFile({
    read: (access) => access.pipe(Effect.ensuring(Queue.offer(reads, undefined))),
  });

const usageScript = {
  id: "usage",
  name: "Usage",
  command: "echo usage",
  icon: "debug",
  runOnWorktreeCreate: false,
} as const;
const perfLabScript = { ...usageScript, id: "perf-lab", name: "Perf lab" } as const;

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

  it.effect("publishes a default project script that another program adds to settings.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ defaultProjectScripts: [usageScript] }),
        );
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ defaultProjectScripts: [usageScript, perfLabScript] }),
        );

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.deepEqual(
          Option.getOrUndefined(change)?.defaultProjectScripts.map((script) => script.id),
          ["usage", "perf-lab"],
        );
        assert.lengthOf((yield* service.getSettings).defaultProjectScripts, 2);
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("keeps the last good settings while settings.json is invalid and warns once", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return Effect.gen(function* () {
      const reads = yield* Queue.unbounded<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* ServerSettingsModule.ServerSettingsService;
          yield* fs.writeFileString(
            config.settingsPath,
            JSON.stringify({ responseStreamingMode: "turn", defaultProjectScripts: [usageScript] }),
          );
          yield* service.start;
          yield* Queue.clear(reads);
          const changes = yield* service.subscribeChanges;
          assert.isTrue((yield* service.getSettings).continueThreadsAfterServerUpdate);

          // A write caught halfway, then one the schema rejects.
          for (const contents of [
            `{ "responseStreamingMode": "turn", "defaultProjectScripts": [`,
            JSON.stringify({ defaultProjectScripts: [{ ...perfLabScript, icon: "no-such-icon" }] }),
          ]) {
            yield* fs.writeFileString(config.settingsPath, contents);
            yield* Queue.take(reads).pipe(Effect.timeout("2 seconds"));
            // The reload holds the write lock, so this snapshot waits for it to finish.
            const kept = yield* service.withSettingsSnapshot(Effect.succeed);
            assert.equal(kept.responseStreamingMode, "turn");
            assert.deepEqual(
              kept.defaultProjectScripts.map((script) => script.id),
              ["usage"],
            );
            // The unreadable file may hold an opt-out, so threads are not resumed meanwhile.
            assert.isFalse(kept.continueThreadsAfterServerUpdate);
          }
          assert.lengthOf(
            messages.filter((message) => message.includes("failed to parse settings.json")),
            1,
          );

          yield* fs.writeFileString(
            config.settingsPath,
            JSON.stringify({
              responseStreamingMode: "turn",
              defaultProjectScripts: [usageScript, perfLabScript],
            }),
          );
          const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
          assert.deepEqual(
            Option.getOrUndefined(change)?.defaultProjectScripts.map((script) => script.id),
            ["usage", "perf-lab"],
          );
          assert.isTrue(Option.getOrUndefined(change)?.continueThreadsAfterServerUpdate);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerServerSettingsReportingReads(reads),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
    }).pipe(TestClock.withLive);
  });

  it.effect("publishes a settings save once, not again when the watcher sees the write", () =>
    Effect.gen(function* () {
      const reads = yield* Queue.unbounded<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* ServerSettingsModule.ServerSettingsService;
          yield* fs.writeFileString(config.settingsPath, "{}");
          yield* service.start;
          yield* Queue.clear(reads);
          const changes = yield* service.subscribeChanges;
          const editPublished = yield* Deferred.make<void>();
          const published = yield* Effect.forkChild(
            changes.pipe(
              Stream.tap((settings) =>
                settings.defaultProjectScripts.length > 0
                  ? Deferred.succeed(editPublished, undefined)
                  : Effect.void,
              ),
              Stream.take(3),
              Stream.runCollect,
            ),
            { startImmediately: true },
          );

          yield* service.updateSettings({ responseStreamingMode: "turn" });
          const savedContents = yield* fs.readFileString(config.settingsPath);
          // One read is the save's own; the next is the watcher reloading the saved file.
          yield* Queue.take(reads);
          yield* Queue.take(reads).pipe(Effect.timeout("2 seconds"));
          yield* fs.writeFileString(
            config.settingsPath,
            JSON.stringify({ responseStreamingMode: "turn", defaultProjectScripts: [usageScript] }),
          );
          yield* Deferred.await(editPublished).pipe(Effect.timeout("2 seconds"));
          // Once another edit is published, the saved contents are an edit of their own.
          yield* fs.writeFileString(config.settingsPath, savedContents);

          const [saved, edited, restored] = yield* Fiber.join(published).pipe(
            Effect.timeout("2 seconds"),
          );
          assert.equal(saved?.responseStreamingMode, "turn");
          assert.deepEqual(saved?.defaultProjectScripts, []);
          assert.deepEqual(
            edited?.defaultProjectScripts.map((script) => script.id),
            ["usage"],
          );
          assert.deepEqual(restored?.defaultProjectScripts, []);
        }),
      ).pipe(Effect.provide(layerServerSettingsReportingReads(reads)));
    }).pipe(TestClock.withLive),
  );

  it.effect("serves the last good settings to a read made during a reload of an invalid file", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>();
      const reloads = yield* Latch.make(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* ServerSettingsModule.ServerSettingsService;
          yield* fs.writeFileString(config.settingsPath, `{ "responseStreamingMode": "turn" }`);
          yield* service.start;
          yield* Queue.clear(started);

          yield* reloads.close;
          yield* fs.writeFileString(config.settingsPath, `{ "responseStreamingMode": `);
          yield* Queue.take(started).pipe(Effect.timeout("2 seconds"));
          const during = yield* Effect.forkChild(service.getSettings, { startImmediately: true });
          yield* reloads.open;

          assert.equal((yield* Fiber.join(during)).responseStreamingMode, "turn");
          const after = yield* service.withSettingsSnapshot(Effect.succeed);
          assert.equal(after.responseStreamingMode, "turn");
        }),
      ).pipe(
        Effect.provide(
          layerServerSettingsAroundFile({
            read: (access) =>
              Queue.offer(started, undefined).pipe(
                Effect.andThen(reloads.await),
                Effect.andThen(access),
              ),
          }),
        ),
      );
    }).pipe(TestClock.withLive),
  );

  it.effect("never pairs a key from a reload with the settings it replaces", () =>
    Effect.gen(function* () {
      const reads = yield* Queue.unbounded<void>();
      const replacing = yield* Queue.unbounded<void>();
      const replaces = yield* Latch.make(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const opencode = ProviderInstanceId.make("opencode");
          const withServer = (serverUrl: string, serverPassword: string) =>
            JSON.stringify({
              providerInstances: {
                opencode: { driver: "opencode", config: { serverUrl, serverPassword } },
              },
            });
          yield* fs.writeFileString(
            config.settingsPath,
            withServer("http://127.0.0.1:4096", "first-password"),
          );
          // Startup moves the password into the secret store and rewrites the file, which the
          // watcher then reloads.
          yield* service.start;
          yield* Queue.take(reads);
          yield* Queue.take(reads).pipe(Effect.timeout("2 seconds"));
          yield* service.withSettingsSnapshot(() => Effect.void);
          yield* Queue.clear(replacing);

          // The reload moves the new password into the store before it rewrites the file.
          yield* replaces.close;
          yield* fs.writeFileString(
            config.settingsPath,
            withServer("http://127.0.0.1:4097", "second-password"),
          );
          yield* Queue.take(replacing).pipe(Effect.timeout("2 seconds"));
          const during = yield* Effect.forkChild(service.getSettings, { startImmediately: true });
          yield* replaces.open;

          assert.deepInclude((yield* Fiber.join(during)).providerInstances[opencode]?.config, {
            serverUrl: "http://127.0.0.1:4097",
            serverPassword: "second-password",
          });
        }),
      ).pipe(
        Effect.provide(
          layerServerSettingsAroundFile({
            read: (access) => access.pipe(Effect.ensuring(Queue.offer(reads, undefined))),
            replace: (access) =>
              Queue.offer(replacing, undefined).pipe(
                Effect.andThen(replaces.await),
                Effect.andThen(access),
              ),
          }),
        ),
      );
    }).pipe(TestClock.withLive),
  );

  it.effect("publishes a provider key that another program rotates in settings.json", () =>
    Effect.gen(function* () {
      const reads = yield* Queue.unbounded<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const instanceId = ProviderInstanceId.make("antigravity");
          const withApiKey = (apiKey: string) =>
            JSON.stringify({
              providerInstances: { antigravity: { driver: "antigravity", config: { apiKey } } },
            });
          yield* fs.writeFileString(config.settingsPath, withApiKey("first-key"));
          // Startup moves the key into the secret store and rewrites the file, which the
          // watcher then reloads.
          yield* service.start;
          yield* Queue.take(reads);
          yield* Queue.take(reads).pipe(Effect.timeout("2 seconds"));
          yield* service.withSettingsSnapshot(() => Effect.void);
          const changes = yield* service.subscribeChanges;

          yield* fs.writeFileString(config.settingsPath, withApiKey("second-key"));

          const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
          assert.propertyVal(
            Option.getOrUndefined(change)?.providerInstances[instanceId]?.config,
            "apiKey",
            "second-key",
          );
          assert.notInclude(yield* fs.readFileString(config.settingsPath), "second-key");
        }),
      ).pipe(Effect.provide(layerServerSettingsReportingReads(reads)));
    }).pipe(TestClock.withLive),
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
      assert.equal(next.textGenerationModelSelection.model, "claude-haiku-5-5");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  // A backend behind a custom model may refuse the built-in default (#12651).
  it.effect("falls back to the thread default when it is a custom model on that instance", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const claude = ProviderInstanceId.make("claudeAgent");
      const providerInstances = {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
        [claude]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["z-ai/glm-5.3-flash"] },
        },
      };

      const custom = yield* serverSettings.updateSettings({
        providerInstances,
        defaultModelSelection: {
          instanceId: claude,
          model: "z-ai/glm-5.3-flash",
          options: [{ id: "thinking", value: false }],
        },
      });
      assert.deepEqual(custom.textGenerationModelSelection, {
        instanceId: claude,
        model: "z-ai/glm-5.3-flash",
        options: [{ id: "thinking", value: false }],
      });

      const builtIn = yield* serverSettings.updateSettings({
        defaultModelSelection: { instanceId: claude, model: "claude-fable-5-1" },
      });
      assert.equal(builtIn.textGenerationModelSelection.model, "claude-haiku-5-5");
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
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next, undefined, null),
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
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored, undefined, null),
          sourceControlWriterModelSelection,
        );
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

      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);

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

  it.effect("migrates legacy providers from an invalid file without rewriting it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const raw =
        '{"addProjectBaseDirectory":42,"continueThreadsAfterServerUpdate":"false","providers":{"codex":{"binaryPath":"/x"}}}';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, raw);

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/x" },
      });

      assert.isFalse(settings.continueThreadsAfterServerUpdate);
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), raw);
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

      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
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
        const client = ServerSettingsModule.redactServerSettingsForClient(saved);
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
          const redacted = ServerSettingsModule.redactServerSettingsForClient(changed);
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
      const client = ServerSettingsModule.redactServerSettingsForClient(saved);
      for (const value of ["legacy-api-key", "legacy-password"]) {
        assert.notInclude(yield* fs.readFileString(config.settingsPath), value);
        assert.notInclude(JSON.stringify(client), value);
      }
      // Editing another field from the client's copy keeps the saved password.
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

        const forClient =
          ServerSettingsModule.redactServerSettingsForClient(saved).sourceControlHosts;
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
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
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
              driver: ProviderDriverKind.make("antigravity"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: { apiKey: "config-kept" },
            },
          },
        });

        rejectNewSecret = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("antigravity"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: { apiKey: "config-new" },
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
        assert.propertyVal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.config,
          "apiKey",
          "config-kept",
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
      assert.isFalse(settings.continueThreadsAfterServerUpdate);
      assert.deepEqual(settings.projectSettingsOverrides, {});

      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), broken);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
