import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { AuthClientMetadataDeviceType, AuthConnectClientStatus } from "@t3tools/contracts";

import {
  type AuthConnectClientRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthConnectClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthConnectClientMetadataRecord = typeof AuthConnectClientMetadataRecord.Type;

export const AuthConnectClientRecord = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  cloudUserId: Schema.String,
  deviceId: Schema.NullOr(Schema.String),
  status: AuthConnectClientStatus,
  client: AuthConnectClientMetadataRecord,
  requestedAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  approvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  rejectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthConnectClientRecord = typeof AuthConnectClientRecord.Type;

export const UpsertAuthConnectClientRequestInput = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  cloudUserId: Schema.String,
  deviceId: Schema.NullOr(Schema.String),
  client: AuthConnectClientMetadataRecord,
  requestedAt: Schema.DateTimeUtcFromString,
});
export type UpsertAuthConnectClientRequestInput = typeof UpsertAuthConnectClientRequestInput.Type;

export const UpdateAuthConnectClientStatusInput = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  status: Schema.Literals(["approved", "rejected"]),
  decidedAt: Schema.DateTimeUtcFromString,
});
export type UpdateAuthConnectClientStatusInput = typeof UpdateAuthConnectClientStatusInput.Type;

export const RevokeAuthConnectClientInput = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthConnectClientInput = typeof RevokeAuthConnectClientInput.Type;

export const MarkAuthConnectClientSeenInput = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  seenAt: Schema.DateTimeUtcFromString,
});
export type MarkAuthConnectClientSeenInput = typeof MarkAuthConnectClientSeenInput.Type;

export class AuthConnectClientRepository extends Context.Service<
  AuthConnectClientRepository,
  {
    readonly upsertRequest: (
      input: UpsertAuthConnectClientRequestInput,
    ) => Effect.Effect<AuthConnectClientRecord, AuthConnectClientRepositoryError>;
    readonly updateStatus: (
      input: UpdateAuthConnectClientStatusInput,
    ) => Effect.Effect<Option.Option<AuthConnectClientRecord>, AuthConnectClientRepositoryError>;
    readonly revoke: (
      input: RevokeAuthConnectClientInput,
    ) => Effect.Effect<boolean, AuthConnectClientRepositoryError>;
    readonly markSeen: (
      input: MarkAuthConnectClientSeenInput,
    ) => Effect.Effect<Option.Option<AuthConnectClientRecord>, AuthConnectClientRepositoryError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthConnectClientRecord>,
      AuthConnectClientRepositoryError
    >;
  }
>()("t3/persistence/AuthConnectClients/AuthConnectClientRepository") {}

const AuthConnectClientDbRow = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  cloudUserId: Schema.String,
  deviceId: Schema.NullOr(Schema.String),
  status: AuthConnectClientStatus,
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  requestedAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  approvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  rejectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const AuthConnectClientRawDbRow = Schema.Struct({
  clientProofKeyThumbprint: Schema.String,
  cloudUserId: Schema.Unknown,
  deviceId: Schema.Unknown,
  status: Schema.Unknown,
  clientLabel: Schema.Unknown,
  clientIpAddress: Schema.Unknown,
  clientUserAgent: Schema.Unknown,
  clientDeviceType: Schema.Unknown,
  clientOs: Schema.Unknown,
  clientBrowser: Schema.Unknown,
  requestedAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
  approvedAt: Schema.Unknown,
  rejectedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
});

const decodeAuthConnectClientDbRow = Schema.decodeUnknownEffect(AuthConnectClientDbRow);

function toAuthConnectClientRecord(
  row: typeof AuthConnectClientDbRow.Type,
): AuthConnectClientRecord {
  return {
    clientProofKeyThumbprint: row.clientProofKeyThumbprint,
    cloudUserId: row.cloudUserId,
    deviceId: row.deviceId,
    status: row.status,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    requestedAt: row.requestedAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
    rejectedAt: row.rejectedAt,
    revokedAt: row.revokedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthConnectClientRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

const rowSelection = `
  client_proof_key_thumbprint AS "clientProofKeyThumbprint",
  cloud_user_id AS "cloudUserId",
  device_id AS "deviceId",
  status AS "status",
  client_label AS "clientLabel",
  client_ip_address AS "clientIpAddress",
  client_user_agent AS "clientUserAgent",
  client_device_type AS "clientDeviceType",
  client_os AS "clientOs",
  client_browser AS "clientBrowser",
  requested_at AS "requestedAt",
  updated_at AS "updatedAt",
  approved_at AS "approvedAt",
  rejected_at AS "rejectedAt",
  revoked_at AS "revokedAt",
  last_seen_at AS "lastSeenAt"
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRequestRow = SqlSchema.findOne({
    Request: UpsertAuthConnectClientRequestInput,
    Result: AuthConnectClientRawDbRow,
    execute: (input) =>
      sql`
        INSERT INTO auth_connect_clients (
          client_proof_key_thumbprint,
          cloud_user_id,
          device_id,
          status,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          requested_at,
          updated_at,
          approved_at,
          rejected_at,
          revoked_at,
          last_seen_at
        )
        VALUES (
          ${input.clientProofKeyThumbprint},
          ${input.cloudUserId},
          ${input.deviceId},
          'pending',
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.requestedAt},
          ${input.requestedAt},
          NULL,
          NULL,
          NULL,
          NULL
        )
        ON CONFLICT(client_proof_key_thumbprint) DO UPDATE SET
          cloud_user_id = excluded.cloud_user_id,
          device_id = excluded.device_id,
          status = CASE
            WHEN auth_connect_clients.revoked_at IS NULL
              AND auth_connect_clients.cloud_user_id = excluded.cloud_user_id
              THEN auth_connect_clients.status
            ELSE 'pending'
          END,
          client_label = excluded.client_label,
          client_ip_address = excluded.client_ip_address,
          client_user_agent = excluded.client_user_agent,
          client_device_type = excluded.client_device_type,
          client_os = excluded.client_os,
          client_browser = excluded.client_browser,
          requested_at = excluded.requested_at,
          updated_at = excluded.updated_at,
          approved_at = CASE
            WHEN auth_connect_clients.revoked_at IS NULL
              AND auth_connect_clients.cloud_user_id = excluded.cloud_user_id
              THEN auth_connect_clients.approved_at
            ELSE NULL
          END,
          rejected_at = CASE
            WHEN auth_connect_clients.revoked_at IS NULL
              AND auth_connect_clients.cloud_user_id = excluded.cloud_user_id
              THEN auth_connect_clients.rejected_at
            ELSE NULL
          END,
          last_seen_at = CASE
            WHEN auth_connect_clients.revoked_at IS NULL
              AND auth_connect_clients.cloud_user_id = excluded.cloud_user_id
              THEN auth_connect_clients.last_seen_at
            ELSE NULL
          END,
          revoked_at = NULL
        RETURNING ${sql.unsafe(rowSelection)}
      `,
  });

  const updateStatusRow = SqlSchema.findOneOption({
    Request: UpdateAuthConnectClientStatusInput,
    Result: AuthConnectClientRawDbRow,
    execute: ({ clientProofKeyThumbprint, status, decidedAt }) =>
      sql`
        UPDATE auth_connect_clients
        SET
          status = ${status},
          updated_at = ${decidedAt},
          approved_at = CASE WHEN ${status} = 'approved' THEN ${decidedAt} ELSE NULL END,
          rejected_at = CASE WHEN ${status} = 'rejected' THEN ${decidedAt} ELSE NULL END,
          last_seen_at = CASE
            WHEN ${status} = 'approved' AND status = 'approved' THEN last_seen_at
            ELSE NULL
          END,
          revoked_at = NULL
        WHERE client_proof_key_thumbprint = ${clientProofKeyThumbprint}
          AND revoked_at IS NULL
        RETURNING ${sql.unsafe(rowSelection)}
      `,
  });

  const revokeRow = SqlSchema.findAll({
    Request: RevokeAuthConnectClientInput,
    Result: Schema.Struct({ clientProofKeyThumbprint: Schema.String }),
    execute: ({ clientProofKeyThumbprint, revokedAt }) =>
      sql`
        UPDATE auth_connect_clients
        SET
          revoked_at = ${revokedAt},
          updated_at = ${revokedAt}
        WHERE client_proof_key_thumbprint = ${clientProofKeyThumbprint}
          AND revoked_at IS NULL
        RETURNING client_proof_key_thumbprint AS "clientProofKeyThumbprint"
      `,
  });

  const markSeenRow = SqlSchema.findOneOption({
    Request: MarkAuthConnectClientSeenInput,
    Result: AuthConnectClientRawDbRow,
    execute: ({ clientProofKeyThumbprint, seenAt }) =>
      sql`
        UPDATE auth_connect_clients
        SET
          last_seen_at = CASE WHEN status = 'approved' THEN ${seenAt} ELSE last_seen_at END,
          updated_at = CASE WHEN status = 'approved' THEN ${seenAt} ELSE updated_at END
        WHERE client_proof_key_thumbprint = ${clientProofKeyThumbprint}
          AND revoked_at IS NULL
        RETURNING ${sql.unsafe(rowSelection)}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AuthConnectClientRawDbRow,
    execute: () =>
      sql`
        SELECT ${sql.unsafe(rowSelection)}
        FROM auth_connect_clients
        WHERE revoked_at IS NULL
        ORDER BY
          CASE status
            WHEN 'pending' THEN 0
            WHEN 'approved' THEN 1
            ELSE 2
          END,
          updated_at DESC,
          client_proof_key_thumbprint DESC
      `,
  });

  const decodeRow = (
    row: typeof AuthConnectClientRawDbRow.Type,
    operation: string,
  ): Effect.Effect<AuthConnectClientRecord, PersistenceDecodeError> =>
    decodeAuthConnectClientDbRow(row).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError(operation, cause, {
          clientProofKeyThumbprint: row.clientProofKeyThumbprint,
        }),
      ),
      Effect.map(toAuthConnectClientRecord),
    );

  const upsertRequest: AuthConnectClientRepository["Service"]["upsertRequest"] = (input) =>
    upsertRequestRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthConnectClientRepository.upsertRequest:query",
          "AuthConnectClientRepository.upsertRequest:decodeRow",
          { clientProofKeyThumbprint: input.clientProofKeyThumbprint },
        ),
      ),
      Effect.flatMap((row) =>
        decodeRow(row, "AuthConnectClientRepository.upsertRequest:decodeRow"),
      ),
    );

  const updateStatus: AuthConnectClientRepository["Service"]["updateStatus"] = (input) =>
    updateStatusRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthConnectClientRepository.updateStatus:query",
          "AuthConnectClientRepository.updateStatus:decodeRow",
          { clientProofKeyThumbprint: input.clientProofKeyThumbprint },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row, "AuthConnectClientRepository.updateStatus:decodeRow").pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const revoke: AuthConnectClientRepository["Service"]["revoke"] = (input) =>
    revokeRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthConnectClientRepository.revoke:query",
          "AuthConnectClientRepository.revoke:decodeRows",
          { clientProofKeyThumbprint: input.clientProofKeyThumbprint },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const markSeen: AuthConnectClientRepository["Service"]["markSeen"] = (input) =>
    markSeenRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthConnectClientRepository.markSeen:query",
          "AuthConnectClientRepository.markSeen:decodeRow",
          { clientProofKeyThumbprint: input.clientProofKeyThumbprint },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row, "AuthConnectClientRepository.markSeen:decodeRow").pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const listActive: AuthConnectClientRepository["Service"]["listActive"] = () =>
    listRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthConnectClientRepository.listActive:query",
          "AuthConnectClientRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeRow(row, "AuthConnectClientRepository.listActive:decodeRows"),
        ),
      ),
    );

  return {
    upsertRequest,
    updateStatus,
    revoke,
    markSeen,
    listActive,
  } satisfies AuthConnectClientRepository["Service"];
});

export const layer = Layer.effect(AuthConnectClientRepository, make);
