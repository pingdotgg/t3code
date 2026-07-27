import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readBackupSearchTags, syncBackupSearchTags } from "./internal.ts";

export interface S3ExportSpecification {
  /** Name of the destination S3 bucket that receives the results `.csv`. */
  destinationBucket: string;
  /** Key prefix under which the results are written. */
  destinationPrefix?: string;
}

export interface ExportSpecification {
  /** Export the search results to an S3 bucket. */
  s3ExportSpecification: S3ExportSpecification;
}

export interface ExportJobProps {
  /**
   * Identifier of the search job whose results are exported. Immutable —
   * changing it replaces the export job.
   */
  searchJobIdentifier: string;
  /**
   * Where the results are exported to. Immutable — changing it replaces the
   * export job.
   */
  exportSpecification: ExportSpecification;
  /**
   * ARN of the IAM role BackupSearch assumes to write the export to the
   * destination bucket. Immutable — changing it replaces the export job.
   */
  roleArn?: string;
  /**
   * User-defined tags for the export job.
   */
  tags?: Record<string, string>;
}

export interface ExportJob extends Resource<
  "AWS.BackupSearch.ExportJob",
  ExportJobProps,
  {
    /**
     * Service-assigned unique ID of the export job.
     */
    exportJobIdentifier: string;
    /**
     * ARN of the export job.
     */
    exportJobArn: string;
    /**
     * ARN of the search job whose results are exported.
     */
    searchJobArn: string | undefined;
    /**
     * Current status of the export job (e.g. `RUNNING`, `COMPLETED`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Backup Search export job — transmits the results of a completed
 * search job to a designated S3 bucket as a `.csv` file, retaining them
 * beyond the search job's seven-day retention. An export job is immutable
 * once started and cannot be stopped or deleted; its record ages out
 * server-side.
 *
 * @resource
 * @section Exporting Search Results
 * @example Export to an S3 Bucket
 * ```typescript
 * const exportJob = yield* BackupSearch.ExportJob("Results", {
 *   searchJobIdentifier: search.searchJobIdentifier,
 *   exportSpecification: {
 *     s3ExportSpecification: {
 *       destinationBucket: bucket.bucketName,
 *       destinationPrefix: "backup-search-results/",
 *     },
 *   },
 *   roleArn: role.roleArn,
 * });
 * ```
 */
export const ExportJob = Resource<ExportJob>("AWS.BackupSearch.ExportJob");

export const ExportJobProvider = () =>
  Provider.effect(
    ExportJob,
    Effect.gen(function* () {
      const get = Effect.fn(function* (exportJobIdentifier: string) {
        return yield* backupsearch
          .getSearchResultExportJob({
            ExportJobIdentifier: exportJobIdentifier,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (
        job:
          | backupsearch.GetSearchResultExportJobOutput
          | backupsearch.ExportJobSummary,
      ) => ({
        exportJobIdentifier: job.ExportJobIdentifier,
        exportJobArn: job.ExportJobArn!,
        searchJobArn: job.SearchJobArn,
        status: (job.Status ?? "UNKNOWN") as string,
      });

      return {
        stables: ["exportJobIdentifier", "exportJobArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (olds.searchJobIdentifier ?? undefined) !==
              (news.searchJobIdentifier ?? undefined) ||
            (olds.roleArn ?? undefined) !== (news.roleArn ?? undefined) ||
            JSON.stringify(olds.exportSpecification ?? null) !==
              JSON.stringify(news.exportSpecification ?? null)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.exportJobIdentifier) return undefined;
          const job = yield* get(output.exportJobIdentifier);
          if (job === undefined) return undefined;
          const attrs = toAttrs(job);
          const tags =
            job.ExportJobArn !== undefined
              ? yield* readBackupSearchTags(job.ExportJobArn)
              : {};
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // OBSERVE — output is only an identifier cache; the job may be gone.
          let job =
            output?.exportJobIdentifier !== undefined
              ? yield* get(output.exportJobIdentifier)
              : undefined;

          // ENSURE — an export job is immutable once started; start it if
          // missing. Any change to its inputs is a replacement (diff).
          if (job === undefined) {
            const started = yield* backupsearch.startSearchResultExportJob({
              SearchJobIdentifier: news.searchJobIdentifier,
              ExportSpecification: {
                s3ExportSpecification: {
                  DestinationBucket:
                    news.exportSpecification.s3ExportSpecification
                      .destinationBucket,
                  DestinationPrefix:
                    news.exportSpecification.s3ExportSpecification
                      .destinationPrefix,
                },
              },
              RoleArn: news.roleArn,
              Tags: desiredTags,
            });
            job = yield* backupsearch.getSearchResultExportJob({
              ExportJobIdentifier: started.ExportJobIdentifier,
            });
          } else if (job.ExportJobArn !== undefined) {
            // SYNC — tags are the only mutable aspect; diff against OBSERVED.
            yield* syncBackupSearchTags(job.ExportJobArn, desiredTags);
          }

          yield* session.note(job.ExportJobIdentifier);
          return toAttrs(job);
        }),

        // An export job cannot be stopped or deleted — its record ages out
        // server-side and the exported .csv lives in the destination bucket.
        delete: () => Effect.void,

        list: () =>
          backupsearch.listSearchResultExportJobs.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ExportJobs ?? [])
                .map(toAttrs),
            ),
          ),
      };
    }),
  );
