import * as d1 from "@distilled.cloud/cloudflare/d1";
import { md5 } from "alchemy/Util/md5";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export interface ImportDatabaseOptions {
  accountId: string;
  databaseId: string;
  sqlData: string | Uint8Array;
  filename?: string;
}

export interface ImportDatabaseResult {
  filename: string;
  numQueries: number;
}

/**
 * A D1 import that Cloudflare accepted but could not finish: the SQL upload
 * was rejected, ingestion reported `status: "error"`, or an in-progress
 * response carried no bookmark to poll.
 */
export class D1ImportError extends Data.TaggedError("D1ImportError")<{
  databaseId: string;
  message: string;
}> {}

/**
 * Import SQL into a D1 database via the multi-step Cloudflare flow:
 *   1. POST `action: "init"` -> returns a presigned `upload_url`, unless D1
 *      already holds a file with this etag, in which case the init response
 *      is itself the first polling response (the import has started).
 *   2. PUT raw SQL to `upload_url` (only when one was returned)
 *   3. POST `action: "ingest"` -> returns the first polling response
 *   4. POST `action: "poll"` with `at_bookmark` until `status === "complete"`
 */
export const importD1Database = Effect.fn(function* (options: ImportDatabaseOptions) {
  const { accountId, databaseId } = options;
  const importDb = yield* d1.importDatabase;
  const client = yield* HttpClient.HttpClient;
  const etag = yield* md5(options.sqlData);

  const init = yield* importDb({ accountId, databaseId, action: "init", etag });

  const sqlData = options.sqlData;
  const uploadUrl = init.uploadUrl;
  let firstPoll = init;
  if (uploadUrl) {
    const bytes =
      typeof sqlData === "string"
        ? yield* Effect.sync(() => new TextEncoder().encode(sqlData))
        : sqlData;
    const putRes = yield* client.execute(
      HttpClientRequest.put(uploadUrl).pipe(
        HttpClientRequest.bodyUint8Array(bytes, "application/sql"),
      ),
    );
    if (putRes.status < 200 || putRes.status >= 300) {
      const text = yield* putRes.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new D1ImportError({
        databaseId,
        message: `Failed to upload SQL file to D1 (${putRes.status}): ${text}`,
      });
    }
    firstPoll = yield* importDb({
      accountId,
      databaseId,
      action: "ingest",
      etag,
      filename: init.filename ?? undefined,
    });
  }

  const poll = (
    response: d1.ImportDatabaseResponse,
  ): Effect.Effect<ImportDatabaseResult, d1.ImportDatabaseError | D1ImportError> =>
    Effect.gen(function* () {
      if (response.status === "complete") {
        return {
          filename: response.filename ?? options.filename ?? init.filename ?? "import.sql",
          numQueries: response.result?.numQueries ?? 0,
        };
      }
      if (response.status === "error") {
        return yield* new D1ImportError({
          databaseId,
          message: response.error ?? "Error during D1 import",
        });
      }
      if (!response.atBookmark) {
        return yield* new D1ImportError({
          databaseId,
          message: response.error ?? "D1 import response is incomplete and has no bookmark to poll",
        });
      }
      return yield* poll(
        yield* importDb({
          accountId,
          databaseId,
          action: "poll",
          currentBookmark: response.atBookmark,
        }),
      );
    });

  return yield* poll(firstPoll);
});
