import { PluginId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PluginStore, PluginStoreError, PluginStoreLive } from "./PluginStore.ts";

const layer = it.layer(PluginStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const pluginId = PluginId.make("t3.test-store");
const Widget = Schema.Struct({
  id: Schema.String,
  count: Schema.Number,
});
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

layer("PluginStore", (it) => {
  it.effect("persists JSON documents and validates collection schemas on read", () =>
    Effect.gen(function* () {
      const store = yield* PluginStore;
      const sql = yield* SqlClient.SqlClient;

      const widgets = yield* store.registerCollection(pluginId, "widgets", Widget);
      yield* widgets.upsert("widget-1", { id: "widget-1", count: 3 });

      const stored = yield* widgets.get("widget-1");
      assert.deepEqual(stored, { id: "widget-1", count: 3 });

      const invalidDocumentJson = yield* encodeUnknownJsonString({
        id: "widget-bad-row",
        count: "bad",
      });
      yield* sql`
        INSERT INTO plugin_documents (
          plugin_id,
          collection,
          document_id,
          document_json,
          created_at,
          updated_at
        )
        VALUES (
          ${pluginId},
          ${"widgets"},
          ${"widget-bad-row"},
          ${invalidDocumentJson},
          ${"2026-01-01T00:00:00.000Z"},
          ${"2026-01-01T00:00:00.000Z"}
        )
      `;

      const readFailure = yield* Effect.result(widgets.get("widget-bad-row"));
      assert.equal(readFailure._tag, "Failure");
      if (readFailure._tag === "Failure") {
        assert.instanceOf(readFailure.failure, PluginStoreError);
      }
    }),
  );
});
