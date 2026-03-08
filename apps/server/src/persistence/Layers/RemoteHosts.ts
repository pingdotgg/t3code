import {
  PositiveInt,
  RemoteHostId,
  RemoteHostRecord,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteRemoteHostInput,
  GetRemoteHostInput,
  RemoteHostRepository,
  type RemoteHostRepositoryShape,
} from "../Services/RemoteHosts.ts";

const RemoteHostRecordRow = Schema.Struct({
  id: RemoteHostId,
  label: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  user: TrimmedNonEmptyString,
  identityFile: Schema.NullOr(TrimmedNonEmptyString),
  sshConfigHost: Schema.NullOr(TrimmedNonEmptyString),
  helperCommand: TrimmedNonEmptyString,
  helperVersion: Schema.NullOr(TrimmedNonEmptyString),
  lastConnectionAttemptAt: Schema.NullOr(Schema.String),
  lastConnectionSucceededAt: Schema.NullOr(Schema.String),
  lastConnectionFailedAt: Schema.NullOr(Schema.String),
  lastConnectionStatus: Schema.Literals(["unknown", "ok", "error"]),
  lastConnectionError: Schema.NullOr(TrimmedNonEmptyString),
});
type RemoteHostRecordRow = typeof RemoteHostRecordRow.Type;

function rowToRemoteHostRecord(row: RemoteHostRecordRow): RemoteHostRecord {
  return {
    ...row,
    identityFile: row.identityFile ?? undefined,
    sshConfigHost: row.sshConfigHost ?? undefined,
  };
}

const makeRemoteHostRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRemoteHostRow = SqlSchema.void({
    Request: RemoteHostRecord,
    execute: (row) =>
      sql`
        INSERT INTO remote_hosts (
          remote_host_id,
          label,
          host,
          port,
          user,
          identity_file,
          ssh_config_host,
          helper_command,
          helper_version,
          last_connection_attempt_at,
          last_connection_succeeded_at,
          last_connection_failed_at,
          last_connection_status,
          last_connection_error
        )
        VALUES (
          ${row.id},
          ${row.label},
          ${row.host},
          ${row.port},
          ${row.user},
          ${row.identityFile},
          ${row.sshConfigHost},
          ${row.helperCommand},
          ${row.helperVersion},
          ${row.lastConnectionAttemptAt},
          ${row.lastConnectionSucceededAt},
          ${row.lastConnectionFailedAt},
          ${row.lastConnectionStatus},
          ${row.lastConnectionError}
        )
        ON CONFLICT (remote_host_id)
        DO UPDATE SET
          label = excluded.label,
          host = excluded.host,
          port = excluded.port,
          user = excluded.user,
          identity_file = excluded.identity_file,
          ssh_config_host = excluded.ssh_config_host,
          helper_command = excluded.helper_command,
          helper_version = excluded.helper_version,
          last_connection_attempt_at = excluded.last_connection_attempt_at,
          last_connection_succeeded_at = excluded.last_connection_succeeded_at,
          last_connection_failed_at = excluded.last_connection_failed_at,
          last_connection_status = excluded.last_connection_status,
          last_connection_error = excluded.last_connection_error
      `,
  });

  const getRemoteHostRow = SqlSchema.findOneOption({
    Request: GetRemoteHostInput,
    Result: RemoteHostRecordRow,
    execute: ({ remoteHostId }) =>
      sql`
        SELECT
          remote_host_id AS "id",
          label,
          host,
          port,
          user,
          identity_file AS "identityFile",
          ssh_config_host AS "sshConfigHost",
          helper_command AS "helperCommand",
          helper_version AS "helperVersion",
          last_connection_attempt_at AS "lastConnectionAttemptAt",
          last_connection_succeeded_at AS "lastConnectionSucceededAt",
          last_connection_failed_at AS "lastConnectionFailedAt",
          last_connection_status AS "lastConnectionStatus",
          last_connection_error AS "lastConnectionError"
        FROM remote_hosts
        WHERE remote_host_id = ${remoteHostId}
      `,
  });

  const listRemoteHostRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RemoteHostRecordRow,
    execute: () =>
      sql`
        SELECT
          remote_host_id AS "id",
          label,
          host,
          port,
          user,
          identity_file AS "identityFile",
          ssh_config_host AS "sshConfigHost",
          helper_command AS "helperCommand",
          helper_version AS "helperVersion",
          last_connection_attempt_at AS "lastConnectionAttemptAt",
          last_connection_succeeded_at AS "lastConnectionSucceededAt",
          last_connection_failed_at AS "lastConnectionFailedAt",
          last_connection_status AS "lastConnectionStatus",
          last_connection_error AS "lastConnectionError"
        FROM remote_hosts
        ORDER BY label ASC, remote_host_id ASC
      `,
  });

  const deleteRemoteHostRow = SqlSchema.void({
    Request: DeleteRemoteHostInput,
    execute: ({ remoteHostId }) =>
      sql`
        DELETE FROM remote_hosts
        WHERE remote_host_id = ${remoteHostId}
      `,
  });

  const upsert: RemoteHostRepositoryShape["upsert"] = (row) =>
    upsertRemoteHostRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteHostRepository.upsert:query")),
    );

  const getById: RemoteHostRepositoryShape["getById"] = (input) =>
    getRemoteHostRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteHostRepository.getById:query")),
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => Effect.succeed(Option.some(rowToRemoteHostRecord(value))),
        }),
      ),
    );

  const listAll: RemoteHostRepositoryShape["listAll"] = () =>
    listRemoteHostRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteHostRepository.listAll:query")),
      Effect.map((rows) => rows.map(rowToRemoteHostRecord)),
    );

  const deleteById: RemoteHostRepositoryShape["deleteById"] = (input) =>
    deleteRemoteHostRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteHostRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies RemoteHostRepositoryShape;
});

export const RemoteHostRepositoryLive = Layer.effect(
  RemoteHostRepository,
  makeRemoteHostRepository,
);
