import { PluginId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

const MAX_KEY_LENGTH = 512;
const MAX_VALUE_BYTES = 1024 * 1024;

export class PluginStoragePersistenceError extends Schema.TaggedError<PluginStoragePersistenceError>()(
  "PluginStoragePersistenceError",
  {
    pluginId: PluginId,
    operation: Schema.Literals(["open", "get", "set", "remove", "list"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Plugin storage ${this.operation} failed for plugin ${this.pluginId}.`;
  }
}

export class PluginStorageKeyError extends Schema.TaggedError<PluginStorageKeyError>()(
  "PluginStorageKeyError",
  {
    pluginId: PluginId,
    length: Schema.Number,
  },
) {
  override get message(): string {
    return `Plugin storage keys must be 1 to ${MAX_KEY_LENGTH} characters long, got ${this.length}.`;
  }
}

export class PluginStorageInvalidValueError extends Schema.TaggedError<PluginStorageInvalidValueError>()(
  "PluginStorageInvalidValueError",
  {
    pluginId: PluginId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Plugin storage values must be JSON.";
  }
}

export class PluginStorageValueTooLargeError extends Schema.TaggedError<PluginStorageValueTooLargeError>()(
  "PluginStorageValueTooLargeError",
  {
    pluginId: PluginId,
    bytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Plugin storage values must be at most ${MAX_VALUE_BYTES} bytes of JSON, got ${this.bytes}.`;
  }
}

export class PluginStorage extends Context.Service<
  PluginStorage,
  {
    readonly get: (
      pluginId: PluginId,
      key: string,
    ) => Effect.Effect<
      Option.Option<Schema.Json>,
      PluginStoragePersistenceError | PluginStorageKeyError
    >;
    readonly set: (
      pluginId: PluginId,
      key: string,
      value: Schema.Json,
    ) => Effect.Effect<
      void,
      | PluginStoragePersistenceError
      | PluginStorageKeyError
      | PluginStorageInvalidValueError
      | PluginStorageValueTooLargeError
    >;
    readonly remove: (
      pluginId: PluginId,
      key: string,
    ) => Effect.Effect<void, PluginStoragePersistenceError | PluginStorageKeyError>;
    /** Keys that start with `prefix`, sorted. */
    readonly list: (
      pluginId: PluginId,
      prefix?: string,
    ) => Effect.Effect<ReadonlyArray<string>, PluginStoragePersistenceError>;
    /** Deletes every key of the plugin, without creating the database when there is none. */
    readonly clear: (pluginId: PluginId) => Effect.Effect<void, PluginStoragePersistenceError>;
  }
>()("t3/plugins/PluginStorage") {}

const ValueJson = Schema.fromJsonString(Schema.Json);
const encodeValue = Schema.encodeUnknownEffect(ValueJson);
const decodeValue = Schema.decodeUnknownEffect(ValueJson);

const checkKey = (pluginId: PluginId, key: string) =>
  key.length >= 1 && key.length <= MAX_KEY_LENGTH
    ? Effect.void
    : Effect.fail(new PluginStorageKeyError({ pluginId, length: key.length }));

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layerScope = yield* Effect.scope;
  const filename = path.join(stateDir, "plugins.sqlite");

  // Opened on first use so a server without plugins never creates the file. A failed open is
  // retried on the next call; a successful one stays open until the layer closes.
  const sqlClient = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const scope = yield* Scope.fork(layerScope);
      return yield* Layer.buildWithScope(NodeSqliteClient.layer({ filename }), scope).pipe(
        Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
        Effect.tap(
          (sql) => sql`
            CREATE TABLE IF NOT EXISTS plugin_storage (
              plugin_id TEXT NOT NULL,
              key TEXT NOT NULL,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (plugin_id, key)
            )
          `,
        ),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    }),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  );

  const open = (pluginId: PluginId) =>
    sqlClient.pipe(
      Effect.mapError(
        (cause) => new PluginStoragePersistenceError({ pluginId, operation: "open", cause }),
      ),
    );

  const get = Effect.fn("PluginStorage.get")(
    function* (pluginId: PluginId, key: string) {
      yield* checkKey(pluginId, key);
      const sql = yield* open(pluginId);
      const rows = yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM plugin_storage WHERE plugin_id = ${pluginId} AND key = ${key}
      `;
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(yield* decodeValue(row.value_json));
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(new PluginStoragePersistenceError({ pluginId, operation: "get", cause })),
          SchemaError: (cause) =>
            Effect.fail(new PluginStoragePersistenceError({ pluginId, operation: "get", cause })),
        }),
      ),
  );

  const set = Effect.fn("PluginStorage.set")(
    function* (pluginId: PluginId, key: string, value: Schema.Json) {
      yield* checkKey(pluginId, key);
      const valueJson = yield* encodeValue(value).pipe(
        Effect.mapError((cause) => new PluginStorageInvalidValueError({ pluginId, cause })),
      );
      const bytes = Buffer.byteLength(valueJson, "utf8");
      if (bytes > MAX_VALUE_BYTES) {
        return yield* new PluginStorageValueTooLargeError({ pluginId, bytes });
      }
      const sql = yield* open(pluginId);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO plugin_storage (plugin_id, key, value_json, updated_at)
        VALUES (${pluginId}, ${key}, ${valueJson}, ${updatedAt})
        ON CONFLICT (plugin_id, key)
        DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `;
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(new PluginStoragePersistenceError({ pluginId, operation: "set", cause })),
        }),
      ),
  );

  const remove = Effect.fn("PluginStorage.remove")(
    function* (pluginId: PluginId, key: string) {
      yield* checkKey(pluginId, key);
      const sql = yield* open(pluginId);
      yield* sql`DELETE FROM plugin_storage WHERE plugin_id = ${pluginId} AND key = ${key}`;
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new PluginStoragePersistenceError({ pluginId, operation: "remove", cause }),
            ),
        }),
      ),
  );

  const list = Effect.fn("PluginStorage.list")(
    function* (pluginId: PluginId, prefix = "") {
      const sql = yield* open(pluginId);
      // Not LIKE: it treats `%` and `_` as wildcards and ignores ASCII case.
      const rows = yield* sql<{ readonly key: string }>`
        SELECT key FROM plugin_storage
        WHERE plugin_id = ${pluginId} AND substr(key, 1, length(${prefix})) = ${prefix}
        ORDER BY key
      `;
      return rows.map((row) => row.key);
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(new PluginStoragePersistenceError({ pluginId, operation: "list", cause })),
        }),
      ),
  );

  const clear = Effect.fn("PluginStorage.clear")(
    function* (pluginId: PluginId) {
      const exists = yield* fileSystem
        .exists(filename)
        .pipe(
          Effect.mapError(
            (cause) => new PluginStoragePersistenceError({ pluginId, operation: "open", cause }),
          ),
        );
      if (!exists) return;
      const sql = yield* open(pluginId);
      yield* sql`DELETE FROM plugin_storage WHERE plugin_id = ${pluginId}`;
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new PluginStoragePersistenceError({ pluginId, operation: "remove", cause }),
            ),
        }),
      ),
  );

  return PluginStorage.of({ get, set, remove, list, clear });
});

export const layer = Layer.effect(PluginStorage, make);
