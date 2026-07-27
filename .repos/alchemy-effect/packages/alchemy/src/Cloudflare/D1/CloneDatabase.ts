import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { exportDatabase } from "./ExportDatabase.ts";
import { importD1Database } from "./ImportDatabase.ts";

export interface CloneDatabaseOptions {
  accountId: string;
  sourceDatabaseId: string;
  targetDatabaseId: string;
}

/**
 * Clone a D1 database by exporting from the source and importing into the
 * target. Fetches the SQL dump from the export's signed URL and streams the
 * payload through the import flow.
 */
export const cloneDatabase = (options: CloneDatabaseOptions) =>
  Effect.gen(function* () {
    const exportResult = yield* exportDatabase({
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
