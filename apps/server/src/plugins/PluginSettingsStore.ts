/**
 * Host-owned storage for declarative plugin settings.
 *
 * Two distinct read paths, deliberately (spec R3.4 / Sol MUST #3):
 *  - `readDraft` serves the WEB form: the ENCODED shape plus a revision token. It
 *    must succeed even when the stored data cannot be decoded, otherwise a plugin
 *    with a required, non-defaulted field could never be configured — the form
 *    would refuse to open on the very data the user needs to fix.
 *  - `readDecoded` serves PLUGIN code: decoded, typed values, with typed failures.
 *
 * @module plugins/PluginSettingsStore
 */
import type { PluginId } from "@t3tools/contracts/plugin";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

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
        return { values: {}, revision: 0, incompatible: false } satisfies PluginSettingsDraft;
      }
      const parsed = yield* decodeJson(row.values_json).pipe(Effect.orElseSucceed(() => null));
      const values = asValues(parsed);
      return {
        values: values ?? {},
        revision: row.revision,
        // A row whose JSON will not parse, or is not an object, is corrupt rather
        // than merely stale — surface it so the form can flag a repair.
        incompatible: values === null,
      } satisfies PluginSettingsDraft;
    }).pipe(
      // The form must always open, including on a corrupt/unreadable row — that is
      // exactly when the user needs it. Fail closed to an empty draft, never error.
      Effect.orElseSucceed(
        () => ({ values: {}, revision: 0, incompatible: true }) satisfies PluginSettingsDraft,
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

  return PluginSettingsStore.of({ readDraft, write, changes });
});

export const layer = Layer.effect(PluginSettingsStore, make());
