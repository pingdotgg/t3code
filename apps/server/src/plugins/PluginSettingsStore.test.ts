import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";

const hello = PluginId.make("hello");

const settingsSchema: Schema.JsonObject = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    name: { type: "string" },
    token: { type: "string", format: "t3-secret" },
  },
  additionalProperties: false,
};

// Like a keychain, this store can't list what it holds.
const layerSecretStoreWithoutFolder = Layer.effect(
  ServerSecretStore.ServerSecretStore,
  Effect.map(ServerSecretStore.make, ({ directory: _directory, ...store }) =>
    ServerSecretStore.ServerSecretStore.of(store),
  ),
);

const layerTest = () =>
  Layer.mergeAll(
    PluginSettingsStore.layer,
    ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layerTest())),
  ).pipe(
    Layer.provideMerge(layerSecretStoreWithoutFolder),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-settings-test-" }),
      ),
    ),
  );

const readSettingsFile = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(
    path.join(stateDir, "plugin-data", hello, "settings.json"),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PluginSettingsStore", (it) => {
  it.effect("rejects values outside the schema without writing them", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      yield* store.update(hello, settingsSchema, { count: 1 });

      const error = yield* Effect.flip(
        store.update(hello, settingsSchema, { count: -1, extra: true }),
      );
      assert.strictEqual(error._tag, "PluginSettingsValidationError");
      assert.include(error.message, 'at ["count"]: Expected a value greater than or equal to 0');
      assert.include(error.message, 'at ["extra"]: Expected no excess property');
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), { count: 1 });

      const unreadable = yield* Effect.flip(
        store.update(hello, { type: "object", properties: { count: { $ref: "#/$defs/no" } } }, {}),
      );
      assert.strictEqual(unreadable._tag, "PluginSettingsSchemaError");
      assert.include(unreadable.message, 'Missing definition "no"');
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("drops keys a newer schema no longer has instead of refusing every save", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const withFoo: Schema.JsonObject = {
        ...settingsSchema,
        properties: {
          ...(settingsSchema.properties as Schema.JsonObject),
          foo: { type: "string" },
        },
      };
      yield* store.update(hello, withFoo, { foo: "old", count: 1 });

      assert.deepStrictEqual(yield* store.update(hello, settingsSchema, { count: 2 }), {
        count: 2,
      });
      assert.deepStrictEqual(JSON.parse(yield* readSettingsFile), { count: 2 });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("gives the plugin its schema's defaults and clients only what is saved", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const withDefaults: Schema.JsonObject = {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
          name: { type: "string", default: "T3" },
          token: { type: "string", format: "t3-secret", default: "not-a-secret" },
        },
        // A required field with a default must not block a save that leaves it unsaved.
        required: ["enabled"],
      };
      const next = yield* store
        .changes(hello)
        .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
      assert.deepStrictEqual(yield* store.get(hello, withDefaults), { enabled: true, name: "T3" });

      yield* store.update(hello, withDefaults, { name: "Mine" });
      assert.deepStrictEqual(yield* store.get(hello, withDefaults), {
        enabled: true,
        name: "Mine",
      });
      assert.deepStrictEqual(yield* Fiber.join(next), Option.some({ enabled: true, name: "Mine" }));
      assert.deepStrictEqual(yield* store.getForClient(hello, withDefaults), { name: "Mine" });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("keeps secrets out of settings.json and redacts them for clients", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const { secretsDir } = yield* ServerConfig.ServerConfig;

      assert.deepStrictEqual(
        yield* store.update(hello, settingsSchema, { name: "a", token: "s3cret" }),
        { name: "a", token: SECRET_REDACTED },
      );
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {
        name: "a",
        token: "s3cret",
      });
      assert.deepStrictEqual(JSON.parse(yield* readSettingsFile), { name: "a" });

      yield* store.update(hello, settingsSchema, { name: "b", token: SECRET_REDACTED });
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {
        name: "b",
        token: "s3cret",
      });

      yield* store.update(hello, settingsSchema, { token: null });
      assert.deepStrictEqual(yield* store.getForClient(hello, settingsSchema), { name: "b" });
      assert.isEmpty(
        yield* FileSystem.FileSystem.use((fileSystem) => fileSystem.readDirectory(secretsDir)),
      );
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("clears every secret a plugin saved, and only its own", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const { secretsDir, stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const longerId = PluginId.make("hello-world");
      yield* store.update(hello, settingsSchema, { token: "old-secret" });
      yield* store.update(longerId, settingsSchema, { token: "other-secret" });
      // A longer id's secrets are kept even when it has no settings folder.
      yield* fileSystem.remove(path.join(stateDir, "plugin-data", longerId), { recursive: true });

      // T3's own upload signing key, whose name starts like this plugin's secrets would.
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const signingKey = yield* secretStore.getOrCreateRandom("plugin-upload-signing-key", 32);

      yield* store.clear(hello);
      yield* store.clear(PluginId.make("upload-signing-key"));

      assert.sameMembers(yield* fileSystem.readDirectory(secretsDir), [
        `plugin.${longerId}.bin`,
        "plugin-upload-signing-key.bin",
      ]);
      assert.deepStrictEqual(yield* store.get(longerId, settingsSchema), { token: "other-secret" });
      // Reinstalling starts fresh, not from the copy the store keeps in memory.
      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {});
      assert.deepStrictEqual(
        yield* secretStore.get("plugin-upload-signing-key"),
        Option.some(signingKey),
      );
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("keeps plugin settings when the server saves its own settings", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      yield* store.update(hello, settingsSchema, { count: 2, token: "s3cret" });

      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/next" });

      assert.deepStrictEqual(yield* store.get(hello, settingsSchema), {
        count: 2,
        token: "s3cret",
      });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("emits the plugin view after an update of that plugin", () =>
    Effect.gen(function* () {
      const store = yield* PluginSettingsStore.PluginSettingsStore;
      const next = yield* store
        .changes(hello)
        .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));

      yield* store.update(PluginId.make("other"), undefined, { count: 9 });
      yield* store.update(hello, settingsSchema, { count: 3, token: "s3cret" });

      assert.deepStrictEqual(yield* Fiber.join(next), Option.some({ count: 3, token: "s3cret" }));
    }).pipe(Effect.provide(layerTest())),
  );
});
