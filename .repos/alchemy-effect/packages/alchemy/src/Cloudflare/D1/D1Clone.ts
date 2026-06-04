import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { exportD1Database } from "./D1Export.ts";
import { importD1Database } from "./D1Import.ts";

export interface CloneD1DatabaseOptions {
  accountId: string;
  sourceDatabaseId: string;
  targetDatabaseId: string;
}

/**
 * Clone a D1 database by exporting from the source and importing into the
 * target. Fetches the SQL dump from the export's signed URL and streams the
 * payload through the import flow.
 */
export const cloneD1Database = (options: CloneD1DatabaseOptions) =>
  Effect.gen(function* () {
    const exportResult = yield* exportD1Database({
      accountId: options.accountId,
      databaseId: options.sourceDatabaseId,
    });

    const client = yield* HttpClient.HttpClient;
    const dumpRes = yield* client
      .execute(HttpClientRequest.get(exportResult.signedUrl))
      .pipe(Effect.orDie);
    if (dumpRes.status < 200 || dumpRes.status >= 300) {
      return yield* Effect.die(
        `Failed to fetch D1 export dump (${dumpRes.status})`,
      );
    }
    const sqlData = yield* dumpRes.text.pipe(Effect.orDie);

    return yield* importD1Database({
      accountId: options.accountId,
      databaseId: options.targetDatabaseId,
      sqlData,
      filename: exportResult.filename,
    });
  });
