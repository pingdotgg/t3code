import * as AWS from "@/AWS";
import { SearchJob } from "@/AWS/BackupSearch";
import * as Test from "@/Test/Alchemy";
import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tag this provider's read/reconcile/delete paths depend on. Runs
// in every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getSearchJob on a nonexistent identifier fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      // Identifiers must be UUID-shaped — anything else is a ValidationException.
      const error = yield* Effect.flip(
        backupsearch.getSearchJob({
          SearchJobIdentifier: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getSearchResultExportJob on a nonexistent identifier fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      // Identifiers must be UUID-shaped — anything else is a ValidationException.
      const error = yield* Effect.flip(
        backupsearch.getSearchResultExportJob({
          ExportJobIdentifier: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "listSearchJobResults on a nonexistent identifier fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      // Underlying operation of the ListSearchJobResults runtime binding.
      const error = yield* Effect.flip(
        backupsearch.listSearchJobResults({
          SearchJobIdentifier: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "listSearchJobBackups on a nonexistent identifier fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      // Underlying operation of the ListSearchJobBackups runtime binding.
      const error = yield* Effect.flip(
        backupsearch.listSearchJobBackups({
          SearchJobIdentifier: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider("listSearchJobs succeeds on an account-level scan", () =>
  Effect.gen(function* () {
    const page = yield* backupsearch.listSearchJobs({ MaxResults: 10 });
    expect(Array.isArray(page.SearchJobs)).toBe(true);
  }),
);

// Search jobs CANNOT be deleted — the API is Start/Stop/Get/List only, and
// AWS retains terminal job records server-side for ~7 days before they age
// out of listSearchJobs. "Orphan-free" for this resource therefore means no
// job is ever left RUNNING: this sweeper stops any still-running job created
// by this test (crash-safe — covers a run that died before stack.destroy()).
// It is idempotent: stopping a job that already reached a terminal state is
// a ConflictException, which means there is nothing to do.
const stopLeakedSearchJobs = Effect.gen(function* () {
  const page = yield* backupsearch.listSearchJobs({
    ByStatus: "RUNNING",
    MaxResults: 25,
  });
  yield* Effect.forEach(
    (page.SearchJobs ?? []).filter((job) =>
      job.Name?.startsWith("start-S3-search-job"),
    ),
    (job) =>
      backupsearch
        .stopSearchJob({ SearchJobIdentifier: job.SearchJobIdentifier! })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.catchTag("ConflictException", () => Effect.void),
        ),
  );
}).pipe(Effect.orDie);

// A search job only produces results when the account has recovery points
// with ACTIVE backup indexes to search — the full lifecycle is gated behind
// AWS_TEST_BACKUP_SEARCH=1. Search jobs cannot be deleted (7-day server-side
// retention); destroy stops the job if it is still RUNNING, and terminal
// job records aging out server-side are the BackupSearch equivalent of a
// KMS key in PENDING_DELETION — handled, not leaked.
test.provider.skipIf(!process.env.AWS_TEST_BACKUP_SEARCH)(
  "start S3 search job, verify, destroy (stop)",
  (stack) =>
    Effect.gen(function* () {
      // Pre-clean: stop any RUNNING job left over from a crashed prior run.
      yield* stopLeakedSearchJobs;
      yield* stack.destroy();

      const { job } = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* SearchJob("Search", {
            searchScope: { backupResourceTypes: ["S3"] },
            itemFilters: {
              s3ItemFilters: [
                {
                  objectKeys: [{ value: "alchemy-", operator: "BEGINS_WITH" }],
                },
              ],
            },
            tags: { fixture: "backup-search" },
          });
          return { job };
        }),
      );

      expect(job.searchJobIdentifier).toBeDefined();
      expect(job.searchJobArn).toContain("search-job");
      // In an account without indexed recovery points the job fails fast;
      // the resource lifecycle (start/observe/stop) is identical either way.
      expect(["RUNNING", "COMPLETED", "FAILED"]).toContain(job.status);

      // Out-of-band verification via distilled.
      const observed = yield* backupsearch.getSearchJob({
        SearchJobIdentifier: job.searchJobIdentifier,
      });
      expect(observed.SearchJobArn).toBe(job.searchJobArn);
      const tags = yield* backupsearch.listTagsForResource({
        ResourceArn: job.searchJobArn,
      });
      expect(tags.Tags?.fixture).toBe("backup-search");

      // Replacement: the search scope/filters are immutable — changing them
      // must start a NEW search job with a new identifier.
      const { job: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* SearchJob("Search", {
            searchScope: { backupResourceTypes: ["S3"] },
            itemFilters: {
              s3ItemFilters: [
                {
                  objectKeys: [{ value: "replaced-", operator: "BEGINS_WITH" }],
                },
              ],
            },
            tags: { fixture: "backup-search" },
          });
          return { job };
        }),
      );
      expect(replaced.searchJobIdentifier).not.toBe(job.searchJobIdentifier);

      // NOTE: a live ExportJob lifecycle additionally requires a search job
      // in COMPLETED or STOPPED status. In an account without indexed
      // recovery points every search job ends FAILED ("Export is only
      // supported for search job with COMPLETED,STOPPED statuses. SearchJob
      // has status FAILED"), so export coverage needs real, indexed backups.

      // Destroy stops the job (or no-ops if it already completed); the job
      // record itself is retained by AWS for 7 days and cannot be deleted.
      yield* stack.destroy();
      const after = yield* backupsearch.getSearchJob({
        SearchJobIdentifier: replaced.searchJobIdentifier,
      });
      expect(["STOPPING", "STOPPED", "COMPLETED", "FAILED"]).toContain(
        after.Status,
      );
    }).pipe(
      // Crash-safe teardown: even if any assertion above fails mid-flight,
      // never leave a search job RUNNING. (Terminal records are un-deletable
      // and age out server-side within ~7 days.)
      Effect.ensuring(stopLeakedSearchJobs),
    ),
  { timeout: 120_000 },
);
