import { PluginId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export class PluginStoreError extends Error {
  override readonly name = "PluginStoreError";
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}

const PluginDocumentRow = Schema.Struct({
  pluginId: PluginId,
  collection: Schema.String,
  documentId: Schema.String,
  documentJson: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type PluginDocumentRow = typeof PluginDocumentRow.Type;

const PluginDocumentKey = Schema.Struct({
  pluginId: PluginId,
  collection: Schema.String,
  documentId: Schema.String,
});

const PluginCollectionKey = Schema.Struct({
  pluginId: PluginId,
  collection: Schema.String,
});

const PluginDocumentUpsert = Schema.Struct({
  pluginId: PluginId,
  collection: Schema.String,
  documentId: Schema.String,
  documentJson: Schema.String,
  now: Schema.String,
});

type CollectionSchema<A, I> = Schema.Codec<A, I>;

export interface PluginStoreCollection<A> {
  readonly list: () => Effect.Effect<ReadonlyArray<A>, PluginStoreError | PersistenceSqlError>;
  readonly get: (
    documentId: string,
  ) => Effect.Effect<A | null, PluginStoreError | PersistenceSqlError>;
  readonly upsert: (
    documentId: string,
    document: A,
  ) => Effect.Effect<void, PluginStoreError | PersistenceSqlError>;
  readonly delete: (documentId: string) => Effect.Effect<void, PersistenceSqlError>;
}

export interface PluginStoreShape {
  readonly registerCollection: <A, I>(
    pluginId: PluginId,
    collection: string,
    schema: CollectionSchema<A, I>,
  ) => Effect.Effect<PluginStoreCollection<A>>;
  readonly deleteCollection: (
    pluginId: PluginId,
    collection: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class PluginStore extends Context.Service<PluginStore, PluginStoreShape>()(
  "t3/plugins/PluginStore",
) {}

const makePluginStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: PluginCollectionKey,
    Result: PluginDocumentRow,
    execute: ({ pluginId, collection }) =>
      sql`
        SELECT
          plugin_id AS "pluginId",
          collection,
          document_id AS "documentId",
          document_json AS "documentJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM plugin_documents
        WHERE plugin_id = ${pluginId}
          AND collection = ${collection}
        ORDER BY updated_at DESC, document_id ASC
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: PluginDocumentKey,
    Result: PluginDocumentRow,
    execute: ({ pluginId, collection, documentId }) =>
      sql`
        SELECT
          plugin_id AS "pluginId",
          collection,
          document_id AS "documentId",
          document_json AS "documentJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM plugin_documents
        WHERE plugin_id = ${pluginId}
          AND collection = ${collection}
          AND document_id = ${documentId}
      `,
  });

  const upsertRow = SqlSchema.void({
    Request: PluginDocumentUpsert,
    execute: ({ pluginId, collection, documentId, documentJson, now }) =>
      sql`
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
          ${collection},
          ${documentId},
          ${documentJson},
          ${now},
          ${now}
        )
        ON CONFLICT (plugin_id, collection, document_id)
        DO UPDATE SET
          document_json = excluded.document_json,
          updated_at = excluded.updated_at
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: PluginDocumentKey,
    execute: ({ pluginId, collection, documentId }) =>
      sql`
        DELETE FROM plugin_documents
        WHERE plugin_id = ${pluginId}
          AND collection = ${collection}
          AND document_id = ${documentId}
      `,
  });

  const deleteCollectionRows = SqlSchema.void({
    Request: PluginCollectionKey,
    execute: ({ pluginId, collection }) =>
      sql`
        DELETE FROM plugin_documents
        WHERE plugin_id = ${pluginId}
          AND collection = ${collection}
      `,
  });

  const decodeDocument = <A, I>(schema: CollectionSchema<A, I>, row: PluginDocumentRow) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.documentJson).pipe(
      Effect.mapError(
        (detail) =>
          new PluginStoreError(
            `Plugin document ${row.pluginId}/${row.collection}/${row.documentId} failed schema validation.`,
            detail,
          ),
      ),
    );

  const encodeDocument = <A, I>(
    pluginId: PluginId,
    collection: string,
    documentId: string,
    schema: CollectionSchema<A, I>,
    document: A,
  ) =>
    Schema.decodeUnknownEffect(schema)(document).pipe(
      Effect.mapError(
        (detail) =>
          new PluginStoreError(
            `Plugin document ${pluginId}/${collection}/${documentId} failed schema validation.`,
            detail,
          ),
      ),
      Effect.flatMap((decoded) =>
        Schema.encodeEffect(Schema.fromJsonString(schema))(decoded).pipe(
          Effect.mapError(
            (detail) =>
              new PluginStoreError(
                `Plugin document ${pluginId}/${collection}/${documentId} failed JSON encoding.`,
                detail,
              ),
          ),
        ),
      ),
    );

  const makeCollection = <A, I>(
    pluginId: PluginId,
    collection: string,
    schema: CollectionSchema<A, I>,
  ): PluginStoreCollection<A> => ({
    list: () =>
      Effect.gen(function* () {
        const rows = yield* listRows({ pluginId, collection }).pipe(
          Effect.mapError(toPersistenceSqlError("PluginStore.list:query")),
        );
        return yield* Effect.forEach(rows, (row) => decodeDocument(schema, row), {
          concurrency: 1,
        });
      }),
    get: (documentId) =>
      Effect.gen(function* () {
        const row = yield* getRow({ pluginId, collection, documentId }).pipe(
          Effect.mapError(toPersistenceSqlError("PluginStore.get:query")),
        );
        if (Option.isNone(row)) {
          return null;
        }
        return yield* decodeDocument(schema, row.value);
      }),
    upsert: (documentId, document) =>
      Effect.gen(function* () {
        const documentJson = yield* encodeDocument(
          pluginId,
          collection,
          documentId,
          schema,
          document,
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* upsertRow({
          pluginId,
          collection,
          documentId,
          documentJson,
          now,
        }).pipe(Effect.mapError(toPersistenceSqlError("PluginStore.upsert:query")));
      }),
    delete: (documentId) =>
      deleteRow({ pluginId, collection, documentId }).pipe(
        Effect.mapError(toPersistenceSqlError("PluginStore.delete:query")),
      ),
  });

  return PluginStore.of({
    registerCollection: (pluginId, collection, schema) =>
      Effect.sync(() => {
        return makeCollection(pluginId, collection, schema);
      }),

    deleteCollection: (pluginId, collection) =>
      deleteCollectionRows({ pluginId, collection }).pipe(
        Effect.mapError(toPersistenceSqlError("PluginStore.deleteCollection:query")),
      ),
  });
});

export const PluginStoreLive = Layer.effect(PluginStore, makePluginStore);
