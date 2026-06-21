import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ExternalArtifactKind,
  ExternalArtifactLink,
  ExternalDeliveryReceipt,
  ExternalEventReceipt,
  ExternalEventSource,
  ExternalIntegrationRepository,
  type ExternalIntegrationRepositoryShape,
  ExternalThreadLink,
  ExternalThreadSource,
} from "../Services/ExternalIntegrations.ts";

const JsonUnknown = Schema.fromJsonString(Schema.Unknown);

const ExternalThreadLinkDbRow = ExternalThreadLink.mapFields(
  Struct.assign({
    muted: Schema.Number,
    metadata: JsonUnknown,
  }),
);

const ExternalEventReceiptDbRow = ExternalEventReceipt.mapFields(
  Struct.assign({
    metadata: JsonUnknown,
  }),
);

const ExternalArtifactLinkDbRow = ExternalArtifactLink.mapFields(
  Struct.assign({
    metadata: JsonUnknown,
  }),
);

const ExternalDeliveryReceiptDbRow = ExternalDeliveryReceipt.mapFields(
  Struct.assign({
    metadata: JsonUnknown,
  }),
);

const ThreadLinkLookupInput = Schema.Struct({
  source: ExternalThreadSource,
  externalThreadId: Schema.String,
});

const ThreadIdLookupInput = Schema.Struct({
  t3ThreadId: ThreadId,
});

const SetThreadMutedInput = Schema.Struct({
  source: ExternalThreadSource,
  externalThreadId: Schema.String,
  muted: Schema.Boolean,
  updatedAt: Schema.String,
});

const EventReceiptLookupInput = Schema.Struct({
  source: ExternalEventSource,
  eventId: Schema.String,
});

const ArtifactLookupInput = Schema.Struct({
  kind: ExternalArtifactKind,
  externalId: Schema.String,
});

const DeliveryReceiptLookupInput = Schema.Struct({
  source: ExternalEventSource,
  deliveryKey: Schema.String,
});

const mapThreadLinkRow = (row: typeof ExternalThreadLinkDbRow.Type): ExternalThreadLink => ({
  ...row,
  muted: row.muted !== 0,
});

const makeExternalIntegrationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertThreadLinkRow = SqlSchema.void({
    Request: ExternalThreadLink,
    execute: (link) =>
      sql`
        INSERT INTO external_thread_links (
          source,
          external_thread_id,
          t3_thread_id,
          project_id,
          primary_external_message_id,
          url,
          muted,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          ${link.source},
          ${link.externalThreadId},
          ${link.t3ThreadId},
          ${link.projectId},
          ${link.primaryExternalMessageId},
          ${link.url},
          ${link.muted ? 1 : 0},
          ${JSON.stringify(link.metadata ?? {})},
          ${link.createdAt},
          ${link.updatedAt}
        )
        ON CONFLICT (source, external_thread_id)
        DO UPDATE SET
          t3_thread_id = excluded.t3_thread_id,
          project_id = excluded.project_id,
          primary_external_message_id = COALESCE(
            external_thread_links.primary_external_message_id,
            excluded.primary_external_message_id
          ),
          url = COALESCE(excluded.url, external_thread_links.url),
          muted = excluded.muted,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
  });

  const getThreadLinkRow = SqlSchema.findOneOption({
    Request: ThreadLinkLookupInput,
    Result: ExternalThreadLinkDbRow,
    execute: ({ source, externalThreadId }) =>
      sql`
        SELECT
          source,
          external_thread_id AS "externalThreadId",
          t3_thread_id AS "t3ThreadId",
          project_id AS "projectId",
          primary_external_message_id AS "primaryExternalMessageId",
          url,
          muted,
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_thread_links
        WHERE source = ${source}
          AND external_thread_id = ${externalThreadId}
      `,
  });

  const listThreadLinksByThreadRows = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ExternalThreadLinkDbRow,
    execute: ({ t3ThreadId }) =>
      sql`
        SELECT
          source,
          external_thread_id AS "externalThreadId",
          t3_thread_id AS "t3ThreadId",
          project_id AS "projectId",
          primary_external_message_id AS "primaryExternalMessageId",
          url,
          muted,
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_thread_links
        WHERE t3_thread_id = ${t3ThreadId}
        ORDER BY created_at ASC, source ASC, external_thread_id ASC
      `,
  });

  const setThreadMutedRow = SqlSchema.void({
    Request: SetThreadMutedInput,
    execute: ({ source, externalThreadId, muted, updatedAt }) =>
      sql`
        UPDATE external_thread_links
        SET muted = ${muted ? 1 : 0},
            updated_at = ${updatedAt}
        WHERE source = ${source}
          AND external_thread_id = ${externalThreadId}
      `,
  });

  const upsertEventReceiptRow = SqlSchema.void({
    Request: ExternalEventReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO external_event_receipts (
          source,
          event_id,
          status,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          ${receipt.source},
          ${receipt.eventId},
          ${receipt.status},
          ${JSON.stringify(receipt.metadata ?? {})},
          ${receipt.createdAt},
          ${receipt.updatedAt}
        )
        ON CONFLICT (source, event_id)
        DO UPDATE SET
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
  });

  const getEventReceiptRow = SqlSchema.findOneOption({
    Request: EventReceiptLookupInput,
    Result: ExternalEventReceiptDbRow,
    execute: ({ source, eventId }) =>
      sql`
        SELECT
          source,
          event_id AS "eventId",
          status,
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_event_receipts
        WHERE source = ${source}
          AND event_id = ${eventId}
      `,
  });

  const upsertArtifactLinkRow = SqlSchema.void({
    Request: ExternalArtifactLink,
    execute: (artifact) =>
      sql`
        INSERT INTO external_artifact_links (
          kind,
          external_id,
          t3_thread_id,
          url,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          ${artifact.kind},
          ${artifact.externalId},
          ${artifact.t3ThreadId},
          ${artifact.url},
          ${JSON.stringify(artifact.metadata ?? {})},
          ${artifact.createdAt},
          ${artifact.updatedAt}
        )
        ON CONFLICT (kind, external_id)
        DO UPDATE SET
          t3_thread_id = excluded.t3_thread_id,
          url = COALESCE(excluded.url, external_artifact_links.url),
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
  });

  const getArtifactLinkRow = SqlSchema.findOneOption({
    Request: ArtifactLookupInput,
    Result: ExternalArtifactLinkDbRow,
    execute: ({ kind, externalId }) =>
      sql`
        SELECT
          kind,
          external_id AS "externalId",
          t3_thread_id AS "t3ThreadId",
          url,
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_artifact_links
        WHERE kind = ${kind}
          AND external_id = ${externalId}
      `,
  });

  const upsertDeliveryReceiptRow = SqlSchema.void({
    Request: ExternalDeliveryReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO external_delivery_receipts (
          source,
          delivery_key,
          status,
          external_message_id,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          ${receipt.source},
          ${receipt.deliveryKey},
          ${receipt.status},
          ${receipt.externalMessageId},
          ${JSON.stringify(receipt.metadata ?? {})},
          ${receipt.createdAt},
          ${receipt.updatedAt}
        )
        ON CONFLICT (source, delivery_key)
        DO UPDATE SET
          status = excluded.status,
          external_message_id = COALESCE(
            excluded.external_message_id,
            external_delivery_receipts.external_message_id
          ),
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
  });

  const getDeliveryReceiptRow = SqlSchema.findOneOption({
    Request: DeliveryReceiptLookupInput,
    Result: ExternalDeliveryReceiptDbRow,
    execute: ({ source, deliveryKey }) =>
      sql`
        SELECT
          source,
          delivery_key AS "deliveryKey",
          status,
          external_message_id AS "externalMessageId",
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_delivery_receipts
        WHERE source = ${source}
          AND delivery_key = ${deliveryKey}
      `,
  });

  const mapPersistenceError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(operation));

  return {
    upsertThreadLink: (link) =>
      upsertThreadLinkRow(link).pipe(
        mapPersistenceError("ExternalIntegrationRepository.upsertThreadLink:query"),
      ),
    getThreadLink: (input) =>
      getThreadLinkRow(input).pipe(
        Effect.map(Option.map(mapThreadLinkRow)),
        mapPersistenceError("ExternalIntegrationRepository.getThreadLink:query"),
      ),
    listThreadLinksByThread: (t3ThreadId) =>
      listThreadLinksByThreadRows({ t3ThreadId }).pipe(
        Effect.map((rows) => rows.map(mapThreadLinkRow)),
        mapPersistenceError("ExternalIntegrationRepository.listThreadLinksByThread:query"),
      ),
    setThreadMuted: (input) =>
      setThreadMutedRow(input).pipe(
        mapPersistenceError("ExternalIntegrationRepository.setThreadMuted:query"),
      ),
    upsertEventReceipt: (receipt) =>
      upsertEventReceiptRow(receipt).pipe(
        mapPersistenceError("ExternalIntegrationRepository.upsertEventReceipt:query"),
      ),
    getEventReceipt: (input) =>
      getEventReceiptRow(input).pipe(
        mapPersistenceError("ExternalIntegrationRepository.getEventReceipt:query"),
      ),
    upsertArtifactLink: (artifact) =>
      upsertArtifactLinkRow(artifact).pipe(
        mapPersistenceError("ExternalIntegrationRepository.upsertArtifactLink:query"),
      ),
    getArtifactLink: (input) =>
      getArtifactLinkRow(input).pipe(
        mapPersistenceError("ExternalIntegrationRepository.getArtifactLink:query"),
      ),
    upsertDeliveryReceipt: (receipt) =>
      upsertDeliveryReceiptRow(receipt).pipe(
        mapPersistenceError("ExternalIntegrationRepository.upsertDeliveryReceipt:query"),
      ),
    getDeliveryReceipt: (input) =>
      getDeliveryReceiptRow(input).pipe(
        mapPersistenceError("ExternalIntegrationRepository.getDeliveryReceipt:query"),
      ),
  } satisfies ExternalIntegrationRepositoryShape;
});

export const ExternalIntegrationRepositoryLive = Layer.effect(
  ExternalIntegrationRepository,
  makeExternalIntegrationRepository,
);
