/**
 * Host-owned storage for declarative plugin settings.
 *
 * Two distinct read paths, deliberately (spec R3.4 / Sol MUST #3):
 *  - `readDraft` serves the WEB form: the ENCODED shape plus a revision token. It
 *    must succeed even when the stored data cannot be decoded, otherwise a plugin
 *    with a required, non-defaulted field could never be configured — the form
 *    would refuse to open on the very data the user needs to fix.
 * Decoding lives in the HOST (hostApi.settings), not here: this store deals only in
 * the encoded shape. Plugin code gets decoded values with typed failures via the
 * settings capability.
 *
 * @module plugins/PluginSettingsStore
 */
import type { PluginId } from "@t3tools/contracts/plugin";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * A declared settings schema, kept structural so this store does not depend on the
 * plugin SDK's descriptor type.
 */
export type SettingsSchemaLike = Schema.Codec<unknown, unknown, never, never> & {
  readonly fields: Readonly<Record<string, Schema.Top>>;
};

/** Encoded settings payload as stored and as exchanged with the web form. */
export type PluginSettingsValues = Readonly<Record<string, unknown>>;

export interface PluginSettingsDraft {
  readonly values: PluginSettingsValues;
  /** Optimistic-concurrency token; pass back as expectedRevision on write. */
  readonly revision: number;
  /**
   * True when the stored values do not decode against the current schema (e.g. an
   * upgrade changed the shape). The draft is still returned so the form can repair
   * it; plugin-side reads fail instead.
   */
  readonly incompatible: boolean;
  /**
   * The schema shape that produced `values`, or null when nothing is stored.
   *
   * Callers compare this against the plugin's CURRENT schema fingerprint: a
   * mismatch means an upgrade changed the shape, so the stored values may not
   * decode. Surfacing it lets the read path preserve the data and flag it for
   * repair rather than silently misreading it.
   */
  readonly schemaFingerprint: string | null;
}

export class PluginSettingsNotConfiguredError extends Schema.TaggedErrorClass<PluginSettingsNotConfiguredError>()(
  "PluginSettingsNotConfiguredError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has no stored settings and its schema has required fields.`;
  }
}

export class PluginSettingsInvalidStoredError extends Schema.TaggedErrorClass<PluginSettingsInvalidStoredError>()(
  "PluginSettingsInvalidStoredError",
  { pluginId: Schema.String, detail: Schema.String },
) {
  // Message is derived from the plugin id and a redacted detail only — never from
  // the stored values, which would leak configuration into logs.
  override get message(): string {
    return `Plugin ${this.pluginId} has stored settings that do not match its current schema.`;
  }
}

export class PluginSettingsConflictError extends Schema.TaggedErrorClass<PluginSettingsConflictError>()(
  "PluginSettingsConflictError",
  { pluginId: Schema.String, expectedRevision: Schema.Number, actualRevision: Schema.Number },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} settings changed since revision ${this.expectedRevision} (now ${this.actualRevision}).`;
  }
}

export class PluginSettingsStore extends Context.Service<
  PluginSettingsStore,
  {
    /** Encoded values + revision for the web form. Never fails on undecodable data. */
    readonly readDraft: (pluginId: PluginId) => Effect.Effect<PluginSettingsDraft>;

    /**
     * Replace the stored values. `expectedRevision` must match the current row
     * (0 when no row exists yet) or the write fails with a conflict rather than
     * clobbering a concurrent writer.
     */
    readonly write: (input: {
      readonly pluginId: PluginId;
      readonly values: PluginSettingsValues;
      readonly schemaFingerprint: string;
      readonly expectedRevision: number;
    }) => Effect.Effect<number, PluginSettingsConflictError | SqlError>;

    /**
     * Emits after every successful write for this plugin. Carries no payload:
     * subscribers re-read, so a slow subscriber cannot observe a stale value it
     * would otherwise have to reconcile against the row.
     */
    readonly changes: (pluginId: PluginId) => Stream.Stream<void>;

    /**
     * Deletes a plugin's stored settings.
     *
     * Called when uninstall removes plugin data. Without it, "Remove plugin data"
     * left settings behind and reinstalling the same id silently RECOVERED the old
     * values — the user asked for their configuration to be gone and it wasn't.
     *
     * Fails loudly: reconcile removes the lockfile entry after this, so swallowing a
     * deletion error would report success while the values survive, and a reinstall
     * would expose settings the user believes are gone.
     */
    readonly remove: (pluginId: PluginId) => Effect.Effect<void, SqlError>;

    /**
     * Records the settings schema a plugin DECLARED, as soon as its module loads —
     * before `register()` runs and therefore before the runtime exists.
     *
     * This is what keeps the repair path reachable. The settings RPC used to resolve
     * the schema from the runtime registry, which is only populated after a
     * successful `register()`. A plugin that reads its settings during `register()`
     * fails activation when the stored row is unreadable, so there is no runtime, so
     * the RPC reported "no settings declared" — and the repair UI was unavailable
     * exactly when the user needed it. Declaring at load time breaks that deadlock.
     */
    readonly noteDeclaredSchema: (
      pluginId: PluginId,
      schema: SettingsSchemaLike,
    ) => Effect.Effect<void>;

    /**
     * Drops a plugin's declared schema.
     *
     * Called at load time when a plugin's CURRENT definition declares no settings —
     * an upgrade from a schema-declaring version to a schema-less one. Without it the
     * `declared` map only ever grew, so the settings RPC would fall back to the OLD
     * version's schema whenever the schema-less reload had no live runtime (e.g. its
     * `register()` failed): a stale settings/repair form, and writes validated against
     * a schema the code no longer has.
     */
    readonly clearDeclaredSchema: (pluginId: PluginId) => Effect.Effect<void>;

    /** The declared schema, whether or not the plugin activated. */
    readonly declaredSchema: (
      pluginId: PluginId,
    ) => Effect.Effect<Option.Option<SettingsSchemaLike>>;
  }
>()("t3/plugins/PluginSettingsStore") {}

interface SettingsRow {
  readonly values_json: string;
  readonly schema_fingerprint: string;
  readonly revision: number;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

const asValues = (parsed: unknown): PluginSettingsValues | null =>
  typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as PluginSettingsValues)
    : null;

export const make = Effect.fn("PluginSettingsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Unbounded: a settings write is a rare, user-driven event, and dropping one
  // would leave a plugin running on config the user believes they changed.
  const writes = yield* PubSub.unbounded<PluginId>();
  // Declared at module load, before register() — see noteDeclaredSchema. Process-
  // local by design: it describes the code currently loaded, not persisted state.
  const declared = new Map<PluginId, SettingsSchemaLike>();

  const readRow = (pluginId: PluginId) =>
    sql<SettingsRow>`
      SELECT values_json, schema_fingerprint, revision
      FROM plugin_settings
      WHERE plugin_id = ${pluginId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const readDraft: PluginSettingsStore["Service"]["readDraft"] = (pluginId) =>
    Effect.gen(function* () {
      const row = yield* readRow(pluginId);
      if (row === null) {
        return {
          values: {},
          revision: 0,
          incompatible: false,
          schemaFingerprint: null,
        } satisfies PluginSettingsDraft;
      }
      const parsed = yield* decodeJson(row.values_json).pipe(Effect.orElseSucceed(() => null));
      const values = asValues(parsed);
      return {
        values: values ?? {},
        revision: row.revision,
        // A row whose JSON will not parse, or is not an object, is corrupt rather
        // than merely stale — surface it so the form can flag a repair.
        incompatible: values === null,
        schemaFingerprint: row.schema_fingerprint,
      } satisfies PluginSettingsDraft;
    }).pipe(
      // The form must always open, including on a corrupt/unreadable row — that is
      // exactly when the user needs it. Fail closed to an empty draft, never error.
      Effect.orElseSucceed(
        () =>
          ({
            values: {},
            revision: 0,
            incompatible: true,
            schemaFingerprint: null,
          }) satisfies PluginSettingsDraft,
      ),
    );

  const write: PluginSettingsStore["Service"]["write"] = (input) =>
    Effect.gen(function* () {
      const nextRevision = input.expectedRevision + 1;
      const json = yield* encodeJson(input.values).pipe(Effect.orDie);
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

      // RETURNING decides the CAS: rows come back only if a row actually matched.
      //
      // Do NOT try to verify by re-reading the revision afterwards. That cannot
      // distinguish "my write landed" from "a concurrent write coincidentally left
      // the row at the same number": a stale writer at expectedRevision=1 computes
      // nextRevision=2, and the winner has already moved the row to 2, so the
      // re-read matches and the conflict goes undetected. (This is not
      // hypothetical — it is the bug the concurrency test caught.)
      const applied =
        input.expectedRevision === 0
          ? // No row expected. WHERE NOT EXISTS makes "create" lose the race rather
            // than overwrite a row another writer just created.
            yield* sql<{ readonly revision: number }>`
              INSERT INTO plugin_settings (plugin_id, values_json, schema_fingerprint, revision, updated_at)
              SELECT ${input.pluginId}, ${json}, ${input.schemaFingerprint}, ${nextRevision}, ${now}
              WHERE NOT EXISTS (SELECT 1 FROM plugin_settings WHERE plugin_id = ${input.pluginId})
              RETURNING revision
            `
          : yield* sql<{ readonly revision: number }>`
              UPDATE plugin_settings
              SET values_json = ${json},
                  schema_fingerprint = ${input.schemaFingerprint},
                  revision = ${nextRevision},
                  updated_at = ${now}
              WHERE plugin_id = ${input.pluginId} AND revision = ${input.expectedRevision}
              RETURNING revision
            `;

      if (applied.length === 0) {
        const current = yield* readRow(input.pluginId);
        return yield* new PluginSettingsConflictError({
          pluginId: input.pluginId,
          expectedRevision: input.expectedRevision,
          actualRevision: current?.revision ?? 0,
        });
      }
      yield* PubSub.publish(writes, input.pluginId);
      return nextRevision;
    });

  const changes: PluginSettingsStore["Service"]["changes"] = (pluginId) =>
    Stream.fromPubSub(writes).pipe(
      Stream.filter((written) => written === pluginId),
      Stream.map(() => undefined),
    );

  const remove: PluginSettingsStore["Service"]["remove"] = (pluginId) =>
    sql`DELETE FROM plugin_settings WHERE plugin_id = ${pluginId}`.pipe(
      Effect.asVoid,
      // Do NOT swallow failures here. Reconcile removes the lockfile entry after
      // this, so an ignored deletion error reports success while the values survive
      // — and a reinstall then exposes settings the user asked to delete. Failing
      // loudly keeps the entry, so the removal is retried rather than lost.
      Effect.tapCause((cause) =>
        Effect.logWarning("failed to delete plugin settings", {
          pluginId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const noteDeclaredSchema: PluginSettingsStore["Service"]["noteDeclaredSchema"] = (
    pluginId,
    schema,
  ) =>
    Effect.sync(() => {
      declared.set(pluginId, schema);
    });

  const clearDeclaredSchema: PluginSettingsStore["Service"]["clearDeclaredSchema"] = (pluginId) =>
    Effect.sync(() => {
      declared.delete(pluginId);
    });

  const declaredSchema: PluginSettingsStore["Service"]["declaredSchema"] = (pluginId) =>
    Effect.sync(() => {
      const schema = declared.get(pluginId);
      return schema === undefined ? Option.none() : Option.some(schema);
    });

  return PluginSettingsStore.of({
    readDraft,
    write,
    changes,
    remove,
    noteDeclaredSchema,
    clearDeclaredSchema,
    declaredSchema,
  });
});

export const layer = Layer.effect(PluginSettingsStore, make());
