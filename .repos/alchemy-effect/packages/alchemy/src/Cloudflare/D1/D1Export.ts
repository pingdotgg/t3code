import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export interface ExportD1DatabaseOptions {
  accountId: string;
  databaseId: string;
  dumpOptions?: {
    tables?: string[];
    noSchema?: boolean;
    noData?: boolean;
  };
}

export interface ExportD1DatabaseResult {
  filename: string;
  signedUrl: string;
}

/**
 * Initiates an export of a Cloudflare D1 database and returns a signed
 * download URL. Recursively polls with the bookmark until the export
 * completes or fails.
 */
export const exportD1Database = (
  options: ExportD1DatabaseOptions,
): Effect.Effect<
  ExportD1DatabaseResult,
  d1.ExportDatabaseError,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const exportDb = yield* d1.exportDatabase;

    const poll = (
      currentBookmark?: string,
    ): Effect.Effect<ExportD1DatabaseResult, d1.ExportDatabaseError, never> =>
      Effect.gen(function* () {
        const data = yield* exportDb({
          accountId: options.accountId,
          databaseId: options.databaseId,
          outputFormat: "polling",
          currentBookmark,
          dumpOptions: options.dumpOptions,
        });

        if (data.status === "complete" && data.result) {
          if (!data.result.filename || !data.result.signedUrl) {
            return yield* Effect.die(
              "D1 export completed but missing filename/signedUrl",
            );
          }
          return {
            filename: data.result.filename,
            signedUrl: data.result.signedUrl,
          };
        }
        if (data.status === "error") {
          return yield* Effect.die(data.error ?? "Error during D1 export");
        }
        return yield* poll(data.atBookmark ?? undefined);
      });

    return yield* poll();
  });
