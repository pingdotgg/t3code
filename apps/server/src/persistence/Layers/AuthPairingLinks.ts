import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
  type AuthPairingLinkRepositoryError,
} from "../Errors.ts";
import {
  AuthPairingLinkRecord,
  AuthPairingLinkRepository,
  type AuthPairingLinkRepositoryShape,
  ConsumeAuthPairingLinkInput,
  CreateAuthPairingLinkInput,
  GetAuthPairingLinkByCredentialInput,
  ListActiveAuthPairingLinksInput,
  RevokeAuthPairingLinkInput,
} from "../Services/AuthPairingLinks.ts";

const AuthPairingLinkRawDbRow = Schema.Struct({
  id: Schema.String,
  credential: Schema.Unknown,
  method: Schema.Unknown,
  scopes: Schema.Unknown,
  subject: Schema.Unknown,
  label: Schema.Unknown,
  proofKeyThumbprint: Schema.Unknown,
  createdAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  consumedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
});

const decodeAuthPairingLinkDbRow = Schema.decodeUnknownEffect(AuthPairingLinkRecord);

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthPairingLinkRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

const makeAuthPairingLinkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createPairingLinkRow = SqlSchema.void({
    Request: CreateAuthPairingLinkInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          ${input.id},
          ${input.credential},
          ${input.method},
          ${JSON.stringify(input.scopes)},
          ${input.subject},
          ${input.label},
          ${input.proofKeyThumbprint},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL
        )
      `,
  });

  const consumeAvailablePairingLinkRow = SqlSchema.findOneOption({
    Request: ConsumeAuthPairingLinkInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ credential, proofKeyThumbprint, consumedAt, now }) =>
      sql`
        UPDATE auth_pairing_links
        SET consumed_at = ${consumedAt}
        WHERE credential = ${credential}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
          AND (
            proof_key_thumbprint IS NULL
            OR proof_key_thumbprint = ${proofKeyThumbprint}
          )
        RETURNING
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt"
      `,
  });

  const listActivePairingLinkRows = SqlSchema.findAll({
    Request: ListActiveAuthPairingLinksInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt"
        FROM auth_pairing_links
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY created_at DESC, id DESC
      `,
  });

  const revokePairingLinkRow = SqlSchema.findAll({
    Request: RevokeAuthPairingLinkInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt}
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const getPairingLinkRowByCredential = SqlSchema.findOneOption({
    Request: GetAuthPairingLinkByCredentialInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ credential }) =>
      sql`
        SELECT
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt"
        FROM auth_pairing_links
        WHERE credential = ${credential}
      `,
  });

  const create: AuthPairingLinkRepositoryShape["create"] = (input) =>
    createPairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.create:query",
          "AuthPairingLinkRepository.create:encodeRequest",
          { pairingLinkId: input.id },
        ),
      ),
    );

  const consumeAvailable: AuthPairingLinkRepositoryShape["consumeAvailable"] = (input) =>
    consumeAvailablePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.consumeAvailable:query",
          "AuthPairingLinkRepository.consumeAvailable:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.consumeAvailable:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const listActive: AuthPairingLinkRepositoryShape["listActive"] = (input) =>
    listActivePairingLinkRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.listActive:query",
          "AuthPairingLinkRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthPairingLinkDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthPairingLinkRepository.listActive:decodeRows",
                cause,
                { pairingLinkId: row.id },
              ),
            ),
          ),
        ),
      ),
    );

  const revoke: AuthPairingLinkRepositoryShape["revoke"] = (input) =>
    revokePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revoke:query",
          "AuthPairingLinkRepository.revoke:decodeRows",
          { pairingLinkId: input.id },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getByCredential: AuthPairingLinkRepositoryShape["getByCredential"] = (input) =>
    getPairingLinkRowByCredential(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getByCredential:query",
          "AuthPairingLinkRepository.getByCredential:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.getByCredential:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  return {
    create,
    consumeAvailable,
    listActive,
    revoke,
    getByCredential,
  } satisfies AuthPairingLinkRepositoryShape;
});

export const AuthPairingLinkRepositoryLive = Layer.effect(
  AuthPairingLinkRepository,
  makeAuthPairingLinkRepository,
);
