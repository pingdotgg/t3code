import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readDataExchangeTags, syncDataExchangeTags } from "./internal.ts";

export interface RevisionProps {
  /**
   * The unique identifier of the data set the revision belongs to.
   * Changing it replaces the revision.
   */
  dataSetId: string;
  /**
   * An optional comment about the revision (up to 16,348 characters).
   * Mutable in place.
   */
  comment?: string;
  /**
   * Whether the revision is finalized. A revision can only be finalized once
   * it contains at least one asset (imported via a DataExchange job) —
   * finalizing an empty revision fails with a `ValidationException`.
   * @default false
   */
  finalized?: boolean;
  /**
   * Tags to apply to the revision. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Revision extends Resource<
  "AWS.DataExchange.Revision",
  RevisionProps,
  {
    /**
     * The unique identifier of the revision.
     */
    revisionId: string;
    /**
     * The ARN of the revision.
     */
    revisionArn: string;
    /**
     * The unique identifier of the data set the revision belongs to.
     */
    dataSetId: string;
    /**
     * Whether the revision is finalized.
     */
    finalized: boolean;
  },
  never,
  Providers
> {}

/**
 * A revision of an AWS Data Exchange data set — a versioned container of
 * assets. Providers import assets into a revision (via DataExchange jobs) and
 * then finalize it to make the snapshot available to subscribers.
 *
 * @resource
 * @section Creating Revisions
 * @example Revision with a comment
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const dataSet = yield* AWS.DataExchange.DataSet("Prices", {
 *   description: "Daily commodity price snapshots",
 * });
 *
 * const revision = yield* AWS.DataExchange.Revision("PricesV1", {
 *   dataSetId: dataSet.dataSetId,
 *   comment: "Initial snapshot",
 * });
 * ```
 *
 * @section Finalizing
 * Once assets have been imported into the revision (via a DataExchange
 * import job), flip `finalized` to publish it. Finalizing an empty revision
 * fails.
 *
 * @example Finalize a revision that has assets
 * ```typescript
 * const revision = yield* AWS.DataExchange.Revision("PricesV1", {
 *   dataSetId: dataSet.dataSetId,
 *   comment: "Initial snapshot",
 *   finalized: true,
 * });
 * ```
 */
export const Revision = Resource<Revision>("AWS.DataExchange.Revision");

export const RevisionProvider = () =>
  Provider.effect(
    Revision,
    Effect.gen(function* () {
      /** Get a revision by ids; typed not-found → undefined. */
      const getById = Effect.fn(function* (
        dataSetId: string,
        revisionId: string,
      ) {
        return yield* dataexchange
          .getRevision({ DataSetId: dataSetId, RevisionId: revisionId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /**
       * Scan a data set's revisions for one carrying our ownership tags.
       * Revision ids are server-generated, so recovery from a lost output
       * (state-persistence failure) goes through per-revision tag inspection.
       */
      const findByTags = Effect.fn(function* (id: string, dataSetId: string) {
        return yield* dataexchange.listDataSetRevisions
          .items({ DataSetId: dataSetId })
          .pipe(
            Stream.mapEffect(
              Effect.fn(function* (entry) {
                const tags = yield* readDataExchangeTags(entry.Arn);
                return (yield* hasAlchemyTags(id, tags)) ? entry : undefined;
              }),
            ),
            Stream.filter((entry) => entry !== undefined),
            Stream.runHead,
            Effect.map((head) =>
              head._tag === "Some" ? head.value : undefined,
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["revisionId", "revisionArn", "dataSetId"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const dataSetId = output?.dataSetId ?? olds?.dataSetId;
          if (dataSetId === undefined) return undefined;
          const revision = output?.revisionId
            ? yield* getById(dataSetId, output.revisionId)
            : yield* findByTags(id, dataSetId);
          if (revision === undefined) return undefined;
          const attrs = {
            revisionId: revision.Id!,
            revisionArn: revision.Arn!,
            dataSetId,
            finalized: revision.Finalized ?? false,
          };
          const tags = yield* readDataExchangeTags(attrs.revisionArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if ((news.dataSetId as string) !== (olds.dataSetId as string)) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const dataSetId = news.dataSetId as string;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredFinalized = news.finalized ?? false;

          // 1. Observe — output ids are only a cache; fall back to a
          //    tag-ownership scan of the data set's revisions.
          let revision = output?.revisionId
            ? yield* getById(dataSetId, output.revisionId)
            : undefined;
          if (revision === undefined) {
            revision = yield* findByTags(id, dataSetId);
          }

          // 2. Ensure — create when missing.
          if (revision === undefined) {
            revision = yield* dataexchange.createRevision({
              DataSetId: dataSetId,
              Comment: news.comment,
              Tags: desiredTags,
            });
          }

          // 3. Sync — comment and finalized are mutable in one call. Only
          //    call the API on an actual delta.
          if (
            (revision.Comment ?? undefined) !== (news.comment ?? undefined) ||
            (revision.Finalized ?? false) !== desiredFinalized
          ) {
            revision = yield* dataexchange.updateRevision({
              DataSetId: dataSetId,
              RevisionId: revision.Id!,
              Comment: news.comment,
              Finalized: desiredFinalized,
            });
          }

          // 3b. Sync tags against OBSERVED cloud tags (adoption-safe).
          yield* syncDataExchangeTags(revision.Arn!, desiredTags);

          yield* session.note(revision.Arn!);
          return {
            revisionId: revision.Id!,
            revisionArn: revision.Arn!,
            dataSetId,
            finalized: revision.Finalized ?? false,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dataexchange
            .deleteRevision({
              DataSetId: output.dataSetId,
              RevisionId: output.revisionId,
            })
            .pipe(
              // Asset deletions inside the revision can transiently conflict.
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Revisions are sub-resources keyed by their parent data set; there
        // is no account-level enumeration into a parentless Attributes shape.
        list: () => Effect.succeed([]),
      };
    }),
  );
