import * as BackupSearch from "@/AWS/BackupSearch";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic name so the crash-safe sweeper in Bindings.test.ts can find
// (and stop) any job a crashed prior run left RUNNING.
export const FIXTURE_SEARCH_JOB_NAME = "alchemy-test-backupsearch-bindings";

export class BackupSearchTestFunction extends Lambda.Function<Lambda.Function>()(
  "BackupSearchTestFunction",
) {}

export default BackupSearchTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // The fixture search job scans S3 recovery points for a prefix that
    // matches nothing — the job's lifecycle (and both list operations) are
    // identical whether or not the account has indexed recovery points.
    const search = yield* BackupSearch.SearchJob("BindingsSearch", {
      name: FIXTURE_SEARCH_JOB_NAME,
      searchScope: { backupResourceTypes: ["S3"] },
      itemFilters: {
        s3ItemFilters: [
          {
            objectKeys: [
              { value: "alchemy-bindings-", operator: "BEGINS_WITH" },
            ],
          },
        ],
      },
      tags: { fixture: "backup-search-bindings" },
    });

    // --- search-job-scoped bindings ---
    const listSearchJobResults =
      yield* BackupSearch.ListSearchJobResults(search);
    const listSearchJobBackups =
      yield* BackupSearch.ListSearchJobBackups(search);
    const getSearchJob = yield* BackupSearch.GetSearchJob(search);

    const bound = { listSearchJobResults, listSearchJobBackups, getSearchJob };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/results") {
          const page = yield* listSearchJobResults({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: page.Results.length,
            nextToken: page.NextToken ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/job") {
          const job = yield* getSearchJob();
          return yield* HttpServerResponse.json({
            status: job.Status ?? null,
            name: job.Name ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/backups") {
          const page = yield* listSearchJobBackups({ MaxResults: 25 });
          return yield* HttpServerResponse.json({
            count: page.Results.length,
            statuses: page.Results.map((backup) => backup.Status ?? null),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BackupSearch.ListSearchJobResultsHttp,
        BackupSearch.ListSearchJobBackupsHttp,
        BackupSearch.GetSearchJobHttp,
      ),
    ),
  ),
);
