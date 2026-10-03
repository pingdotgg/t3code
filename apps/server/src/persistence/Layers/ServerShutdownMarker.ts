import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ServerShutdownMarkerRepository,
  type ServerShutdownMarkerRepositoryShape,
} from "../Services/ServerShutdownMarker.ts";

const makeServerShutdownMarkerRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectMarker = Effect.gen(function* () {
    const rows = yield* sql<{ readonly cleanShutdownAt: string | null }>`
      SELECT clean_shutdown_at AS "cleanShutdownAt"
      FROM server_shutdown_marker
      WHERE id = 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ServerShutdownMarkerRepository.beginSession:read")),
    );
    return rows[0]?.cleanShutdownAt ?? null;
  });

  const clearMarker = sql`
    UPDATE server_shutdown_marker
    SET clean_shutdown_at = ''
    WHERE id = 1
  `.pipe(
    Effect.mapError(toPersistenceSqlError("ServerShutdownMarkerRepository.beginSession:clear")),
  );

  return {
    beginSession: () =>
      Effect.gen(function* () {
        const recordedShutdownAt = yield* selectMarker;
        // An empty string is the "unset" sentinel: the row exists but this
        // process already consumed the previous process's verdict.
        const previousShutdownWasClean = (recordedShutdownAt ?? "") !== "";
        yield* clearMarker;
        return previousShutdownWasClean;
      }),
    recordCleanShutdown: (cleanShutdownAt) =>
      sql`
        INSERT INTO server_shutdown_marker (id, clean_shutdown_at)
        VALUES (1, ${cleanShutdownAt})
        ON CONFLICT (id) DO UPDATE SET
          clean_shutdown_at = excluded.clean_shutdown_at
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ServerShutdownMarkerRepository.recordCleanShutdown:write"),
        ),
      ),
  } satisfies ServerShutdownMarkerRepositoryShape;
});

export const ServerShutdownMarkerRepositoryLive = Layer.effect(
  ServerShutdownMarkerRepository,
  makeServerShutdownMarkerRepository,
);
