import * as d1 from "@distilled.cloud/cloudflare/d1";
import {
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export interface ImportD1DatabaseOptions {
  accountId: string;
  databaseId: string;
  sqlData: string | Uint8Array;
  filename?: string;
}

export interface ImportD1DatabaseResult {
  filename: string;
  numQueries: number;
}

interface ImportPollingResponse {
  at_bookmark?: string | null;
  error?: string | null;
  filename?: string | null;
  messages?: string[] | null;
  result?: {
    final_bookmark?: string | null;
    num_queries?: number | null;
  } | null;
  status?: "complete" | "error" | null;
  success?: boolean | null;
  upload_url?: string | null;
}

const md5 = (data: string | Uint8Array): string =>
  crypto.createHash("md5").update(data).digest("hex");

const importEndpoint = (
  apiBaseUrl: string,
  accountId: string,
  databaseId: string,
) => `${apiBaseUrl}/accounts/${accountId}/d1/database/${databaseId}/import`;

/**
 * Import SQL into a D1 database via the multi-step Cloudflare flow:
 *   1. POST `action: "init"` -> returns presigned `upload_url`
 *   2. PUT raw SQL to `upload_url`
 *   3. POST `action: "ingest"` -> returns `at_bookmark`
 *   4. POST `action: "poll"` until `status === "complete"`
 */
export const importD1Database = (options: ImportD1DatabaseOptions) =>
  Effect.gen(function* () {
    const credentialsEff = yield* Credentials;
    const credentials = yield* credentialsEff;
    const authHeaders = formatHeaders(credentials);
    const url = importEndpoint(
      credentials.apiBaseUrl,
      options.accountId,
      options.databaseId,
    );
    const client = yield* HttpClient.HttpClient;

    const postJson = (
      body: unknown,
    ): Effect.Effect<ImportPollingResponse, never, never> =>
      Effect.gen(function* () {
        const req = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(authHeaders),
          HttpClientRequest.bodyJsonUnsafe(body),
        );
        const res = yield* client.execute(req).pipe(Effect.orDie);
        if (res.status < 200 || res.status >= 300) {
          const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* Effect.die(
            `D1 import request failed (${res.status}): ${text}`,
          );
        }
        const text = yield* res.text.pipe(Effect.orDie);
        const json = JSON.parse(text) as { result: ImportPollingResponse };
        return json.result;
      });

    const etag = md5(options.sqlData);

    // Step 1: init via the typed d1 client
    const initDb = yield* d1.importDatabase;
    const init = yield* initDb({
      accountId: options.accountId,
      databaseId: options.databaseId,
      action: "init",
      etag,
    });

    if (!init.uploadUrl) {
      return yield* Effect.die(
        init.error ?? "Failed to get upload URL for D1 import",
      );
    }
    const uploadFilename = options.filename ?? init.filename ?? "import.sql";

    // Step 2: PUT to the presigned upload URL
    const bytes =
      typeof options.sqlData === "string"
        ? new TextEncoder().encode(options.sqlData)
        : options.sqlData;
    const putReq = HttpClientRequest.put(init.uploadUrl).pipe(
      HttpClientRequest.bodyUint8Array(bytes, "application/sql"),
    );
    const putRes = yield* client.execute(putReq).pipe(Effect.orDie);
    if (putRes.status < 200 || putRes.status >= 300) {
      const text = yield* putRes.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.die(
        `Failed to upload SQL file to D1 (${putRes.status}): ${text}`,
      );
    }

    // Step 3: ingest
    const ingest = yield* postJson({
      action: "ingest",
      etag,
      filename: init.filename,
    });
    if (!ingest.at_bookmark) {
      return yield* Effect.die(
        ingest.error ?? "Ingest response missing bookmark",
      );
    }

    // Step 4: poll until complete
    const poll = (
      bookmark: string,
    ): Effect.Effect<ImportD1DatabaseResult, never, never> =>
      Effect.gen(function* () {
        const data = yield* postJson({
          action: "poll",
          current_bookmark: bookmark,
        });
        if (data.status === "complete" && data.result) {
          return {
            filename: data.filename ?? uploadFilename,
            numQueries: data.result.num_queries ?? 0,
          };
        }
        if (data.status === "error") {
          return yield* Effect.die(data.error ?? "Error during D1 import");
        }
        if (!data.at_bookmark) {
          return yield* Effect.die("D1 import poll missing bookmark");
        }
        return yield* poll(data.at_bookmark);
      });

    return yield* poll(ingest.at_bookmark);
  });
