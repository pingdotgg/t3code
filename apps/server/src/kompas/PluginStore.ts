import {
  type KompasError,
  Plugin,
  PLUGIN_SECRET_REDACTED,
  type PluginState,
  type PluginThreadOverride,
  PluginTool,
  ThreadId,
  type PluginTransport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { KompasDatabase, kompasError, storageError } from "./KompasDatabase.ts";

export class PluginStore extends Context.Service<
  PluginStore,
  {
    /** Every plugin as clients see it, secrets redacted. */
    readonly list: Effect.Effect<ReadonlyArray<PluginState>, KompasError>;
    readonly threadOverrides: Effect.Effect<ReadonlyArray<PluginThreadOverride>, KompasError>;
    /** One plugin with its secrets, for the connection itself. */
    readonly get: (id: string) => Effect.Effect<Plugin, KompasError>;
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Plugin>, KompasError>;
    readonly save: (plugin: Plugin) => Effect.Effect<void, KompasError>;
    readonly remove: (id: string) => Effect.Effect<void, KompasError>;
    readonly setForThread: (input: PluginThreadOverride) => Effect.Effect<void, KompasError>;
    readonly recordConnection: (
      id: string,
      result: {
        readonly tools: ReadonlyArray<PluginTool> | null;
        readonly needsSignIn: boolean;
        readonly error: string | null;
      },
    ) => Effect.Effect<void, KompasError>;
  }
>()("t3/kompas/PluginStore") {}

const Secrets = Schema.Record(Schema.String, Schema.String);
const decodeSecrets = Schema.decodeUnknownOption(Schema.fromJsonString(Secrets));
const encodeSecrets = Schema.encodeSync(Schema.fromJsonString(Secrets));
const decodePlugin = Schema.decodeUnknownEffect(Schema.fromJsonString(Plugin));
const encodePlugin = Schema.encodeSync(Schema.fromJsonString(Plugin));
const decodeTools = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(PluginTool)));
const encodeTools = Schema.encodeSync(Schema.fromJsonString(Schema.Array(PluginTool)));

export const pluginOAuthSecretName = (id: string) =>
  `kompas-plugin-oauth-${Buffer.from(id, "utf8").toString("base64url")}`;
const pluginSecretName = (id: string) =>
  `kompas-plugin-${Buffer.from(id, "utf8").toString("base64url")}`;

const secretsOf = (transport: PluginTransport) =>
  transport.type === "http" ? transport.headers : transport.env;
const withSecrets = (
  transport: PluginTransport,
  secrets: Readonly<Record<string, string>>,
): PluginTransport =>
  transport.type === "http"
    ? { ...transport, headers: secrets }
    : { ...transport, env: secrets };
const redacted = (transport: PluginTransport) =>
  withSecrets(
    transport,
    Object.fromEntries(
      Object.keys(secretsOf(transport)).map((name) => [name, PLUGIN_SECRET_REDACTED]),
    ),
  );

interface PluginRow {
  readonly plugin_json: string;
  readonly tools_json: string;
  readonly needs_sign_in: number;
  readonly error: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = yield* KompasDatabase;
  const secretStore = yield* ServerSecretStore;
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const loadSecrets = (id: string) =>
    secretStore.get(pluginSecretName(id)).pipe(
      Effect.map((secret): Readonly<Record<string, string>> =>
        Option.getOrElse(
          Option.flatMap(secret, (bytes) => decodeSecrets(textDecoder.decode(bytes))),
          () => ({}),
        ),
      ),
      Effect.mapError(storageError),
    );

  const selectRows = sql<PluginRow>`
    SELECT plugin_json, tools_json, needs_sign_in, error FROM kompas_plugins ORDER BY created_at
  `.pipe(Effect.mapError(storageError));

  const list = Effect.gen(function* () {
    return yield* Effect.forEach(yield* selectRows, (row) =>
      decodePlugin(row.plugin_json).pipe(
        Effect.mapError(storageError),
        Effect.map(
          (plugin): PluginState => ({
            ...plugin,
            tools: Option.getOrElse(decodeTools(row.tools_json), () => []),
            needsSignIn: row.needs_sign_in === 1,
            error: row.error,
          }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("PluginStore.list"));

  const threadOverrides = sql<{
    readonly plugin_id: string;
    readonly thread_id: string;
    readonly enabled: number;
  }>`SELECT plugin_id, thread_id, enabled FROM kompas_plugin_threads`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        pluginId: row.plugin_id,
        threadId: ThreadId.make(row.thread_id),
        enabled: row.enabled === 1,
      })),
    ),
    Effect.mapError(storageError),
    Effect.withSpan("PluginStore.threadOverrides"),
  );

  const get = Effect.fn("PluginStore.get")(function* (id: string) {
    const rows = yield* sql<PluginRow>`
      SELECT plugin_json, tools_json, needs_sign_in, error
      FROM kompas_plugins WHERE plugin_id = ${id}
    `.pipe(Effect.mapError(storageError));
    const row = rows[0];
    if (row === undefined) return yield* kompasError("not-found", "This plugin was removed.");
    const plugin = yield* decodePlugin(row.plugin_json).pipe(Effect.mapError(storageError));
    const secrets = yield* loadSecrets(id);
    const values = Object.fromEntries(
      Object.keys(secretsOf(plugin.transport)).map((name) => [name, secrets[name] ?? ""]),
    );
    return { ...plugin, transport: withSecrets(plugin.transport, values) };
  });

  const forThread = Effect.fn("PluginStore.forThread")(function* (threadId: ThreadId) {
    const overrides = new Map(
      (yield* threadOverrides)
        .filter((override) => override.threadId === threadId)
        .map((override) => [override.pluginId, override.enabled]),
    );
    return (yield* list).filter(
      (plugin) => plugin.enabled && (overrides.get(plugin.id) ?? plugin.allConversations),
    );
  });

  const save = Effect.fn("PluginStore.save")(function* (plugin: Plugin) {
    const others = (yield* list).filter((other) => other.id !== plugin.id);
    if (others.some((other) => other.name.toLowerCase() === plugin.name.toLowerCase())) {
      return yield* kompasError("invalid", `A plugin named "${plugin.name}" already exists.`);
    }
    const previous = yield* loadSecrets(plugin.id);
    const secrets = Object.fromEntries(
      Object.entries(secretsOf(plugin.transport)).map(([name, value]) => [
        name,
        value === PLUGIN_SECRET_REDACTED ? (previous[name] ?? "") : value,
      ]),
    );
    yield* secretStore
      .set(pluginSecretName(plugin.id), textEncoder.encode(encodeSecrets(secrets)))
      .pipe(Effect.mapError(storageError));
    const json = encodePlugin({ ...plugin, transport: redacted(plugin.transport) });
    const now = yield* database.now;
    yield* sql`
      INSERT INTO kompas_plugins (plugin_id, plugin_json, created_at)
      VALUES (${plugin.id}, ${json}, ${now})
      ON CONFLICT (plugin_id) DO UPDATE SET plugin_json = excluded.plugin_json
    `.pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
  });

  const remove = Effect.fn("PluginStore.remove")(function* (id: string) {
    yield* sql`DELETE FROM kompas_plugins WHERE plugin_id = ${id}`.pipe(
      Effect.mapError(storageError),
    );
    yield* Effect.forEach([pluginSecretName(id), pluginOAuthSecretName(id)], (name) =>
      secretStore.remove(name).pipe(Effect.mapError(storageError)),
    );
    yield* database.notifyChanged;
  });

  const setForThread = Effect.fn("PluginStore.setForThread")(function* (
    input: PluginThreadOverride,
  ) {
    yield* sql`
      INSERT INTO kompas_plugin_threads (plugin_id, thread_id, enabled)
      VALUES (${input.pluginId}, ${input.threadId}, ${input.enabled ? 1 : 0})
      ON CONFLICT (plugin_id, thread_id) DO UPDATE SET enabled = excluded.enabled
    `.pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
  });

  const recordConnection: PluginStore["Service"]["recordConnection"] = Effect.fn(
    "PluginStore.recordConnection",
  )(function* (id, result) {
    const tools = result.tools === null ? null : encodeTools(result.tools);
    yield* sql`
      UPDATE kompas_plugins SET
        tools_json = COALESCE(${tools}, tools_json),
        needs_sign_in = ${result.needsSignIn ? 1 : 0},
        error = ${result.error}
      WHERE plugin_id = ${id}
    `.pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
  });

  return PluginStore.of({
    list,
    threadOverrides,
    get,
    forThread,
    save,
    remove,
    setForThread,
    recordConnection,
  });
});

export const layer = Layer.effect(PluginStore, make);
