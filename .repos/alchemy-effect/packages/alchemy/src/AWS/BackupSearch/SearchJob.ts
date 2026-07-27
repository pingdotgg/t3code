import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readBackupSearchTags, syncBackupSearchTags } from "./internal.ts";

export interface BackupCreationTimeFilter {
  /** Only include recovery points created after this ISO-8601 timestamp. */
  createdAfter?: string;
  /** Only include recovery points created before this ISO-8601 timestamp. */
  createdBefore?: string;
}

export interface SearchScope {
  /**
   * Resource types of the recovery points to include in the search:
   * `S3` and/or `EBS`.
   */
  backupResourceTypes: string[];
  /** Filter recovery points by their backup creation time. */
  backupResourceCreationTime?: BackupCreationTimeFilter;
  /** Only search backups of these source resources (ARNs). */
  sourceResourceArns?: string[];
  /** Only search these recovery points (recovery point ARNs). */
  backupResourceArns?: string[];
  /** Only search recovery points carrying these tags. */
  backupResourceTags?: Record<string, string>;
}

export interface StringCondition {
  /** The string value to compare against. */
  value: string;
  /**
   * Comparison operator: `EQUALS_TO`, `NOT_EQUALS_TO`, `CONTAINS`,
   * `DOES_NOT_CONTAIN`, `BEGINS_WITH`, `ENDS_WITH`, `DOES_NOT_BEGIN_WITH`,
   * or `DOES_NOT_END_WITH`.
   * @default EQUALS_TO
   */
  operator?: string;
}

export interface LongCondition {
  /** The numeric value to compare against. */
  value: number;
  /**
   * Comparison operator: `EQUALS_TO`, `NOT_EQUALS_TO`,
   * `LESS_THAN_EQUAL_TO`, or `GREATER_THAN_EQUAL_TO`.
   * @default EQUALS_TO
   */
  operator?: string;
}

export interface TimeCondition {
  /** The ISO-8601 timestamp to compare against. */
  value: string;
  /**
   * Comparison operator: `EQUALS_TO`, `NOT_EQUALS_TO`,
   * `LESS_THAN_EQUAL_TO`, or `GREATER_THAN_EQUAL_TO`.
   * @default EQUALS_TO
   */
  operator?: string;
}

export interface S3ItemFilter {
  /** Match S3 objects by key. */
  objectKeys?: StringCondition[];
  /** Match S3 objects by size in bytes. */
  sizes?: LongCondition[];
  /** Match S3 objects by creation time. */
  creationTimes?: TimeCondition[];
  /** Match S3 objects by version id. */
  versionIds?: StringCondition[];
  /** Match S3 objects by ETag. */
  etags?: StringCondition[];
}

export interface EBSItemFilter {
  /** Match EBS files by path. */
  filePaths?: StringCondition[];
  /** Match EBS files by size in bytes. */
  sizes?: LongCondition[];
  /** Match EBS files by creation time. */
  creationTimes?: TimeCondition[];
  /** Match EBS files by last-modification time. */
  lastModificationTimes?: TimeCondition[];
}

export interface ItemFilters {
  /** Filters applied to items inside S3 recovery points. */
  s3ItemFilters?: S3ItemFilter[];
  /** Filters applied to items inside EBS recovery points. */
  ebsItemFilters?: EBSItemFilter[];
}

export interface SearchJobProps {
  /**
   * Display name of the search job. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing the name replaces the job.
   */
  name?: string;
  /**
   * ARN of the KMS key used to encrypt the search results. Immutable —
   * changing it replaces the job.
   */
  encryptionKeyArn?: string;
  /**
   * The recovery points to search. Immutable — changing it replaces the job.
   */
  searchScope: SearchScope;
  /**
   * Filters applied to the items inside the recovery points. Immutable —
   * changing them replaces the job.
   */
  itemFilters?: ItemFilters;
  /**
   * User-defined tags for the search job.
   */
  tags?: Record<string, string>;
}

export interface SearchJob extends Resource<
  "AWS.BackupSearch.SearchJob",
  SearchJobProps,
  {
    /**
     * Service-assigned unique ID of the search job.
     */
    searchJobIdentifier: string;
    /**
     * ARN of the search job.
     */
    searchJobArn: string;
    /**
     * Name of the search job.
     */
    name: string | undefined;
    /**
     * Current status of the search job (e.g. `RUNNING`, `COMPLETED`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Backup Search job — a data-plane search over AWS Backup recovery
 * points (S3 and EBS) whose backup indexes are active. A search job is
 * immutable once started: it runs to completion, retains its results for
 * seven days, and can only be stopped while `RUNNING` (destroying the
 * resource stops a running job; completed jobs age out server-side).
 *
 * @resource
 * @section Creating a Search Job
 * @example Search All S3 Backups
 * ```typescript
 * const search = yield* BackupSearch.SearchJob("FindReports", {
 *   searchScope: { backupResourceTypes: ["S3"] },
 *   itemFilters: {
 *     s3ItemFilters: [
 *       { objectKeys: [{ value: "reports/", operator: "BEGINS_WITH" }] },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Search Specific Recovery Points
 * ```typescript
 * const search = yield* BackupSearch.SearchJob("AuditSearch", {
 *   searchScope: {
 *     backupResourceTypes: ["EBS"],
 *     backupResourceArns: [recoveryPointArn],
 *     backupResourceCreationTime: { createdAfter: "2026-01-01T00:00:00Z" },
 *   },
 * });
 * ```
 */
export const SearchJob = Resource<SearchJob>("AWS.BackupSearch.SearchJob");

const encodeTimeCondition = (
  condition: TimeCondition,
): backupsearch.TimeCondition => ({
  Value: new Date(condition.value),
  Operator: condition.operator,
});

const encodeStringCondition = (
  condition: StringCondition,
): backupsearch.StringCondition => ({
  Value: condition.value,
  Operator: condition.operator,
});

const encodeLongCondition = (
  condition: LongCondition,
): backupsearch.LongCondition => ({
  Value: condition.value,
  Operator: condition.operator,
});

const encodeSearchScope = (scope: SearchScope): backupsearch.SearchScope => ({
  BackupResourceTypes: scope.backupResourceTypes,
  BackupResourceCreationTime: scope.backupResourceCreationTime
    ? {
        CreatedAfter: scope.backupResourceCreationTime.createdAfter
          ? new Date(scope.backupResourceCreationTime.createdAfter)
          : undefined,
        CreatedBefore: scope.backupResourceCreationTime.createdBefore
          ? new Date(scope.backupResourceCreationTime.createdBefore)
          : undefined,
      }
    : undefined,
  SourceResourceArns: scope.sourceResourceArns,
  BackupResourceArns: scope.backupResourceArns,
  BackupResourceTags: scope.backupResourceTags,
});

const encodeItemFilters = (filters: ItemFilters): backupsearch.ItemFilters => ({
  S3ItemFilters: filters.s3ItemFilters?.map((filter) => ({
    ObjectKeys: filter.objectKeys?.map(encodeStringCondition),
    Sizes: filter.sizes?.map(encodeLongCondition),
    CreationTimes: filter.creationTimes?.map(encodeTimeCondition),
    VersionIds: filter.versionIds?.map(encodeStringCondition),
    ETags: filter.etags?.map(encodeStringCondition),
  })),
  EBSItemFilters: filters.ebsItemFilters?.map((filter) => ({
    FilePaths: filter.filePaths?.map(encodeStringCondition),
    Sizes: filter.sizes?.map(encodeLongCondition),
    CreationTimes: filter.creationTimes?.map(encodeTimeCondition),
    LastModificationTimes:
      filter.lastModificationTimes?.map(encodeTimeCondition),
  })),
});

export const SearchJobProvider = () =>
  Provider.effect(
    SearchJob,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: SearchJobProps,
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 60 }));
      });

      const get = Effect.fn(function* (searchJobIdentifier: string) {
        return yield* backupsearch
          .getSearchJob({ SearchJobIdentifier: searchJobIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (job: backupsearch.GetSearchJobOutput) => ({
        searchJobIdentifier: job.SearchJobIdentifier,
        searchJobArn: job.SearchJobArn,
        name: job.Name,
        status: job.Status as string,
      });

      return {
        stables: ["searchJobIdentifier", "searchJobArn", "name"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.encryptionKeyArn ?? undefined) !==
              (news.encryptionKeyArn ?? undefined) ||
            JSON.stringify(olds.searchScope ?? null) !==
              JSON.stringify(news.searchScope ?? null) ||
            JSON.stringify(olds.itemFilters ?? null) !==
              JSON.stringify(news.itemFilters ?? null)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.searchJobIdentifier) return undefined;
          const job = yield* get(output.searchJobIdentifier);
          if (job === undefined) return undefined;
          const attrs = toAttrs(job);
          const tags = yield* readBackupSearchTags(job.SearchJobArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // OBSERVE — output is only an identifier cache; the job may be gone.
          let job =
            output?.searchJobIdentifier !== undefined
              ? yield* get(output.searchJobIdentifier)
              : undefined;

          // ENSURE — a search job is immutable once started; start it if
          // missing. Any change to the scope/filters is a replacement (diff).
          if (job === undefined) {
            const started = yield* backupsearch.startSearchJob({
              Name: name,
              EncryptionKeyArn: news.encryptionKeyArn,
              SearchScope: encodeSearchScope(news.searchScope),
              ItemFilters: news.itemFilters
                ? encodeItemFilters(news.itemFilters)
                : undefined,
              Tags: desiredTags,
            });
            job = yield* backupsearch.getSearchJob({
              SearchJobIdentifier: started.SearchJobIdentifier!,
            });
          } else {
            // SYNC — tags are the only mutable aspect; diff against OBSERVED.
            yield* syncBackupSearchTags(job.SearchJobArn, desiredTags);
          }

          yield* session.note(job.SearchJobIdentifier);
          return toAttrs(job);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A search job cannot be deleted — results age out after 7 days.
          // Stop it if it is still RUNNING; stopping a job in any other
          // state is a ConflictException and means there is nothing to do.
          yield* backupsearch
            .stopSearchJob({
              SearchJobIdentifier: output.searchJobIdentifier,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.catchTag("ConflictException", () => Effect.void),
            );
        }),

        list: () =>
          backupsearch.listSearchJobs.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.SearchJobs ?? [])
                .map((summary) => ({
                  searchJobIdentifier: summary.SearchJobIdentifier!,
                  searchJobArn: summary.SearchJobArn!,
                  name: summary.Name,
                  status: (summary.Status ?? "UNKNOWN") as string,
                })),
            ),
          ),
      };
    }),
  );
