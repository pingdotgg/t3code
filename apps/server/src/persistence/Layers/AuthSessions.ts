import { AuthEnvironmentScopes, AuthSessionId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AuthSessionRepositoryError,
} from "../Errors.ts";
import {
  AuthSessionRecord,
  AuthSessionRepository,
  type AuthSessionRepositoryShape,
  CreateAuthSessionInput,
  GetAuthSessionByIdInput,
  ListActiveAuthSessionsInput,
  ListInactiveAuthSessionIdsInput,
  RevokeAuthSessionInput,
  RevokeOtherAuthSessionsInput,
  SetAuthSessionLastConnectedAtInput,
} from "../Services/AuthSessions.ts";

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  scopes: Schema.NullOr(Schema.fromJsonString(AuthEnvironmentScopes)),
  method: Schema.Literals([
    "browser-session-cookie",
    "bearer-session-token",
    "bearer-access-token",
  ]),
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): typeof AuthSessionRecord.Type {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    role: row.role,
    scopes: row.scopes,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAuthSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createSessionRow = SqlSchema.void({
    Request: CreateAuthSessionInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${input.role},
          ${input.scopes === null ? null : JSON.stringify(input.scopes)},
          ${input.method},
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.issuedAt},
          ${input.expiresAt},
          NULL
        )
      `,
  });

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          role AS "role",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt"
        FROM auth_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          role AS "role",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt"
        FROM auth_sessions
        WHERE revoked_at IS NULL
          AND expires_at > ${now}
        ORDER BY issued_at DESC, session_id DESC
      `,
  });

  const listInactiveSessionIds = SqlSchema.findAll({
    Request: ListInactiveAuthSessionIdsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionIds, now }) =>
      sql`
        SELECT session_id AS "sessionId"
        FROM auth_sessions
        WHERE ${sql.in("session_id", sessionIds)}
          AND (revoked_at IS NOT NULL OR expires_at <= ${now})
      `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) =>
      sql`
        UPDATE auth_sessions
        SET last_connected_at = ${lastConnectedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id <> ${currentSessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const create: AuthSessionRepositoryShape["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: AuthSessionRepositoryShape["getById"] = (input) =>
    getSessionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => Effect.succeed(Option.some(toAuthSessionRecord(row))),
        }),
      ),
    );

  const listActive: AuthSessionRepositoryShape["listActive"] = (input) =>
    listActiveSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => Effect.succeed(rows.map((row) => toAuthSessionRecord(row)))),
    );

  const listInactiveIds: AuthSessionRepositoryShape["listInactiveIds"] = (input) =>
    input.sessionIds.length === 0
      ? Effect.succeed([])
      : listInactiveSessionIds(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "AuthSessionRepository.listInactiveIds:query",
              "AuthSessionRepository.listInactiveIds:decodeRows",
            ),
          ),
          Effect.map((rows) => rows.map((row) => row.sessionId)),
        );

  const revoke: AuthSessionRepositoryShape["revoke"] = (input) =>
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepositoryShape["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setLastConnectedAt: AuthSessionRepositoryShape["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
        ),
      ),
    );

  return {
    create,
    getById,
    listActive,
    listInactiveIds,
    revoke,
    revokeAllExcept,
    setLastConnectedAt,
  } satisfies AuthSessionRepositoryShape;
});

export const AuthSessionRepositoryLive = Layer.effect(
  AuthSessionRepository,
  makeAuthSessionRepository,
);
