import { assert, describe, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PluginSettingsStoreModule from "./PluginSettingsStore.ts";
import { PluginSettingsStore } from "./PluginSettingsStore.ts";

const layer = it.layer(
  PluginSettingsStoreModule.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

// The in-memory sqlite from it.layer is shared across every test in this block,
// so each test MUST use its own plugin id or they clobber each other's rows and
// the revision assertions become order-dependent.
let seq = 0;
const nextPluginId = () => PluginId.make(`settings-fixture-${++seq}`);
const fingerprint = "fp-1";

layer((it) => {
  describe("PluginSettingsStore", () => {
    it.effect("returns an empty draft at revision 0 when nothing is stored", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;
        const draft = yield* store.readDraft(pluginId);
        assert.deepEqual(draft, {
          values: {},
          revision: 0,
          incompatible: false,
          schemaFingerprint: null,
        });
      }),
    );

    it.effect("round-trips values and bumps the revision", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;
        const revision = yield* store.write({
          pluginId,
          values: { baseUrl: "https://example.com" },
          schemaFingerprint: fingerprint,
          expectedRevision: 0,
        });
        assert.equal(revision, 1);
        const draft = yield* store.readDraft(pluginId);
        assert.deepEqual(draft.values, { baseUrl: "https://example.com" });
        assert.equal(draft.revision, 1);
        assert.equal(draft.incompatible, false);
      }),
    );

    // The whole point of the revision token. Without the CAS, the second write
    // silently clobbers the first — two browser tabs lose data with no error.
    it.effect("rejects a write carrying a stale expectedRevision and preserves the winner", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;
        yield* store.write({
          pluginId,
          values: { baseUrl: "first" },
          schemaFingerprint: fingerprint,
          expectedRevision: 0,
        });
        // Both tabs read revision 1; the first write moves it to 2.
        yield* store.write({
          pluginId,
          values: { baseUrl: "second" },
          schemaFingerprint: fingerprint,
          expectedRevision: 1,
        });

        const conflict = yield* Effect.exit(
          store.write({
            pluginId,
            values: { baseUrl: "stale-tab" },
            schemaFingerprint: fingerprint,
            expectedRevision: 1,
          }),
        );
        assert.isTrue(conflict._tag === "Failure", "stale write must not succeed");

        const draft = yield* store.readDraft(pluginId);
        assert.deepEqual(draft.values, { baseUrl: "second" }, "winner's value must survive");
        assert.equal(draft.revision, 2);
      }),
    );

    // expectedRevision 0 means "I believe nothing is stored". If a row already
    // exists, that belief is stale and the create must lose, not overwrite.
    it.effect("rejects a create (expectedRevision 0) when a row already exists", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;
        yield* store.write({
          pluginId,
          values: { baseUrl: "existing" },
          schemaFingerprint: fingerprint,
          expectedRevision: 0,
        });
        const conflict = yield* Effect.exit(
          store.write({
            pluginId,
            values: { baseUrl: "clobber" },
            schemaFingerprint: fingerprint,
            expectedRevision: 0,
          }),
        );
        assert.isTrue(conflict._tag === "Failure");
        const draft = yield* store.readDraft(pluginId);
        assert.deepEqual(draft.values, { baseUrl: "existing" });
      }),
    );

    // The form must open on corrupt data — that is exactly when the user needs it
    // to repair the values. Failing the read would strand the plugin permanently.
    it.effect("returns an incompatible draft rather than failing when the row is corrupt", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO plugin_settings (plugin_id, values_json, schema_fingerprint, revision, updated_at)
          VALUES (${pluginId}, ${"{not json"}, ${fingerprint}, ${3}, ${0})
        `;
        const store = yield* PluginSettingsStore;
        const draft = yield* store.readDraft(pluginId);
        assert.equal(draft.incompatible, true, "corrupt row must be flagged");
        assert.deepEqual(draft.values, {});
      }),
    );

    it.effect("flags a row whose JSON parses but is not an object", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO plugin_settings (plugin_id, values_json, schema_fingerprint, revision, updated_at)
          VALUES (${pluginId}, ${"[1,2,3]"}, ${fingerprint}, ${1}, ${0})
        `;
        const store = yield* PluginSettingsStore;
        const draft = yield* store.readDraft(pluginId);
        assert.equal(draft.incompatible, true);
      }),
    );

    // Storage must hold the ENCODED shape verbatim: if the stored bytes were
    // decoded values, a later read could fail to decode its own output.
    it.effect("stores the encoded payload verbatim in values_json", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;
        yield* store.write({
          pluginId,
          values: { baseUrl: "https://example.com", enabled: true },
          schemaFingerprint: fingerprint,
          expectedRevision: 0,
        });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly values_json: string;
          readonly schema_fingerprint: string;
        }>`
          SELECT values_json, schema_fingerprint FROM plugin_settings WHERE plugin_id = ${pluginId}
        `;
        const stored = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
          rows[0]!.values_json,
        );
        assert.deepEqual(stored, { baseUrl: "https://example.com", enabled: true });
        assert.equal(rows[0]!.schema_fingerprint, fingerprint);
      }),
    );
  });
});

layer((it) => {
  describe("PluginSettingsStore schema fingerprint", () => {
    // An upgrade can change a plugin's schema under already-stored values. The
    // fingerprint is how a reader tells "these values were written for a different
    // shape" from "these values are current" — without it, stale values are read
    // back as if they still matched, which is the silent misread Sol MUST #13 is about.
    it.effect("reports the fingerprint that produced the stored values", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;

        yield* store.write({
          pluginId,
          values: { baseUrl: "https://example.com" },
          schemaFingerprint: "shape-v1",
          expectedRevision: 0,
        });

        const draft = yield* store.readDraft(pluginId);
        assert.equal(draft.schemaFingerprint, "shape-v1");
      }),
    );

    it.effect("reports the NEW fingerprint after a rewrite under a changed shape", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;

        yield* store.write({
          pluginId,
          values: { baseUrl: "https://example.com" },
          schemaFingerprint: "shape-v1",
          expectedRevision: 0,
        });
        yield* store.write({
          pluginId,
          values: { endpoint: "https://example.com" },
          schemaFingerprint: "shape-v2",
          expectedRevision: 1,
        });

        const draft = yield* store.readDraft(pluginId);
        assert.equal(draft.schemaFingerprint, "shape-v2");
        assert.deepEqual(draft.values, { endpoint: "https://example.com" });
      }),
    );

    it.effect("reports a null fingerprint when nothing is stored", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* PluginSettingsStore;
        const draft = yield* store.readDraft(nextPluginId());
        assert.equal(draft.schemaFingerprint, null);
      }),
    );
  });
});

layer((it) => {
  describe("PluginSettingsStore.remove", () => {
    // Settings live in the host DB, not under the plugin directory, so uninstall's
    // filesystem removal does not touch them. Without an explicit delete, "Remove
    // plugin data" then reinstalling the same id recovers the old configuration —
    // the user asked for it to be gone and it wasn't.
    it.effect("deletes stored settings so a reinstall cannot recover them", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;

        yield* store.write({
          pluginId,
          values: { baseUrl: "https://secret.example" },
          schemaFingerprint: fingerprint,
          expectedRevision: 0,
        });
        assert.equal((yield* store.readDraft(pluginId)).revision, 1, "precondition: stored");

        yield* store.remove(pluginId);

        const draft = yield* store.readDraft(pluginId);
        assert.deepEqual(draft.values, {}, "values must be gone, not merely unreferenced");
        assert.equal(draft.revision, 0, "a reinstall must start from a clean revision");
      }),
    );

    it.effect("is a no-op for a plugin with no stored settings", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* PluginSettingsStore;
        yield* store.remove(nextPluginId());
      }),
    );
  });
});

layer((it) => {
  describe("PluginSettingsStore declared schema", () => {
    // A trivial but structurally valid SettingsSchemaLike: Schema.Struct is a Codec
    // and carries `.fields`, which is all the store's declared map requires.
    const schema = Schema.Struct({
      baseUrl: Schema.String,
    }) as unknown as PluginSettingsStoreModule.SettingsSchemaLike;

    // An upgrade from a schema-declaring version to a schema-less one must be able to
    // drop the old declaration; without clear, the map only ever grew and a later
    // read fell back to the removed schema.
    it.effect("clear removes a previously noted declaration", () =>
      Effect.gen(function* () {
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;

        yield* store.noteDeclaredSchema(pluginId, schema);
        assert.isTrue(
          Option.isSome(yield* store.declaredSchema(pluginId)),
          "precondition: schema is declared",
        );

        yield* store.clearDeclaredSchema(pluginId);
        assert.isTrue(
          Option.isNone(yield* store.declaredSchema(pluginId)),
          "clear must drop the declaration",
        );
      }),
    );

    it.effect("clear on an id with no declaration is a no-op", () =>
      Effect.gen(function* () {
        const pluginId = nextPluginId();
        const store = yield* PluginSettingsStore;

        yield* store.clearDeclaredSchema(pluginId);
        assert.isTrue(Option.isNone(yield* store.declaredSchema(pluginId)));
      }),
    );
  });
});

// A SEPARATE layer block: this one destroys the table, which every other test needs.
layer((it) => {
  describe("PluginSettingsStore.remove failure", () => {
    // remove() must FAIL LOUDLY, because reconcile drops the lockfile entry after it.
    // If a deletion error were swallowed (an easy regression to `orElseSucceed`),
    // uninstall would report "data gone" while the row survived — and reinstalling
    // the same id would hand back settings the user believes are deleted.
    it.effect("surfaces a SQL failure instead of reporting a successful delete", () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const sql = yield* SqlClient.SqlClient;
        const store = yield* PluginSettingsStore;
        const pluginId = nextPluginId();

        yield* store.write({
          pluginId,
          values: { baseUrl: "https://secret.example" },
          schemaFingerprint: fingerprint,
          expectedRevision: 0,
        });
        // Break the DELETE for real rather than mocking the client: the statement
        // now targets a table that does not exist.
        yield* sql`DROP TABLE plugin_settings`;

        const exit = yield* Effect.exit(store.remove(pluginId));
        assert.isTrue(
          Exit.isFailure(exit),
          "a failed delete must not be reported as a successful removal",
        );
      }),
    );
  });
});
