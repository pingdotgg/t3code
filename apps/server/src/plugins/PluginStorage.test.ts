import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as PluginStorage from "./PluginStorage.ts";

const hello = PluginId.make("hello");
const other = PluginId.make("other");

const layerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-storage-test-" }));

// A fresh layer per call, so closing it closes its SQLite connection.
const withStorage = <A, E>(
  use: (storage: PluginStorage.PluginStorage["Service"]) => Effect.Effect<A, E>,
) => PluginStorage.PluginStorage.use(use).pipe(Effect.provide(Layer.fresh(PluginStorage.layer)));

it.layer(NodeServices.layer)("PluginStorage", (it) => {
  it.effect("creates its own plugins.sqlite on first use", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(stateDir, "plugins.sqlite");

      yield* withStorage((storage) =>
        Effect.gen(function* () {
          // Removing a plugin's data on a server that never stored any leaves no file behind.
          yield* storage.clear(other);
          assert.isFalse(yield* fileSystem.exists(filename));
          yield* storage.set(hello, "greeting", { text: "hi" });
          yield* storage.set(other, "gone", true);
          yield* storage.clear(other);
          assert.deepStrictEqual(yield* storage.list(other), []);
        }),
      );

      const rows = yield* SqlClient.SqlClient.use(
        (sql) => sql<{ readonly key: string }>`SELECT key FROM plugin_storage`,
      ).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
      assert.deepStrictEqual(
        rows.map((row) => row.key),
        ["greeting"],
      );
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "statev2.sqlite")));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("round-trips values and keeps them after the layer closes", () =>
    Effect.gen(function* () {
      yield* withStorage((storage) =>
        Effect.gen(function* () {
          yield* storage.set(hello, "b", [1, "two", null]);
          yield* storage.set(hello, "a", { nested: { ok: true } });
          yield* storage.set(hello, "gone", 1);
          yield* storage.set(other, "a", "other plugin");
          yield* storage.set(hello, "a", { nested: { ok: false } });
          yield* storage.remove(hello, "gone");

          assert.deepStrictEqual(yield* storage.list(hello), ["a", "b"]);
          assert.deepStrictEqual(yield* storage.get(hello, "gone"), Option.none());
        }),
      );

      yield* withStorage((storage) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* storage.get(hello, "a"),
            Option.some({ nested: { ok: false } }),
          );
          assert.deepStrictEqual(yield* storage.get(hello, "b"), Option.some([1, "two", null]));
          assert.deepStrictEqual(yield* storage.get(other, "a"), Option.some("other plugin"));
        }),
      );
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("matches list prefixes literally", () =>
    withStorage((storage) =>
      Effect.gen(function* () {
        for (const key of ["a_b", "axb", "A_b", "a%c", "abc"]) {
          yield* storage.set(hello, key, true);
        }
        yield* storage.set(other, "a_other", true);

        assert.deepStrictEqual(yield* storage.list(hello, "a_"), ["a_b"]);
        assert.deepStrictEqual(yield* storage.list(hello, "a%"), ["a%c"]);
      }),
    ).pipe(Effect.provide(layerConfig())),
  );

  it.effect("rejects oversize values and keys", () =>
    withStorage((storage) =>
      Effect.gen(function* () {
        const tooLarge = yield* Effect.flip(storage.set(hello, "big", "x".repeat(1024 * 1024)));
        assert.strictEqual(tooLarge._tag, "PluginStorageValueTooLargeError");

        const emptyKey = yield* Effect.flip(storage.set(hello, "", 1));
        assert.strictEqual(emptyKey._tag, "PluginStorageKeyError");
        const longKey = yield* Effect.flip(storage.get(hello, "k".repeat(513)));
        assert.strictEqual(longKey._tag, "PluginStorageKeyError");

        assert.deepStrictEqual(yield* storage.list(hello), []);
      }),
    ).pipe(Effect.provide(layerConfig())),
  );
});
