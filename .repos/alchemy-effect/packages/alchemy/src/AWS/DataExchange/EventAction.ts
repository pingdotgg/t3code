import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readDataExchangeTags, syncDataExchangeTags } from "./internal.ts";

/**
 * Server-side encryption for auto-exported revisions.
 */
export interface EventActionEncryption {
  /**
   * The encryption type: `aws:kms` (with `kmsKeyArn`) or `AES256`.
   */
  type: "aws:kms" | "AES256";
  /**
   * The ARN of the KMS key used to encrypt exported objects when `type` is
   * `aws:kms`.
   */
  kmsKeyArn?: string;
}

/**
 * The auto-export destination of an event action.
 */
export interface EventActionExportRevisionToS3 {
  /**
   * The S3 bucket auto-exported revisions are written to. The bucket policy
   * must allow the AWS Data Exchange service principal to write to it.
   */
  bucket: string;
  /**
   * Pattern for naming exported objects, built from `${Revision.CreatedAt}`
   * and `${Asset.Name}` variables.
   * @default "${Asset.Name}"
   */
  keyPattern?: string;
  /**
   * Server-side encryption applied to exported objects.
   */
  encryption?: EventActionEncryption;
}

export interface EventActionProps {
  /**
   * The id of the ENTITLED data set whose `RevisionPublished` event triggers
   * the action. Event actions can only be created for entitled data sets
   * (subscriptions or accepted data grants), not for owned data sets.
   * Immutable — changing it replaces the event action.
   */
  dataSetId: string;
  /**
   * Where to auto-export newly published revisions. Mutable in place.
   */
  exportRevisionToS3: EventActionExportRevisionToS3;
  /**
   * Tags to apply to the event action. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface EventAction extends Resource<
  "AWS.DataExchange.EventAction",
  EventActionProps,
  {
    /**
     * The unique identifier of the event action.
     */
    eventActionId: string;
    /**
     * The ARN of the event action.
     */
    eventActionArn: string;
    /**
     * The id of the entitled data set the event action watches.
     */
    dataSetId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Data Exchange event action — an auto-export rule that copies every
 * newly published revision of an ENTITLED data set into your S3 bucket the
 * moment the provider publishes it. This is the subscriber-side automation
 * primitive: subscribe to a product (or accept a data grant), attach an
 * event action, and fresh data lands in your bucket with no polling.
 *
 * Event actions require an entitled data set — creating one against an
 * owned data set fails with a `ValidationException`.
 *
 * @resource
 * @section Auto-Exporting Entitled Data
 * @example Export new revisions to S3
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const landing = yield* AWS.S3.Bucket("Landing", {});
 *
 * const autoExport = yield* AWS.DataExchange.EventAction("AutoExport", {
 *   dataSetId: entitledDataSetId,
 *   exportRevisionToS3: { bucket: landing.bucketName },
 * });
 * ```
 *
 * @example Encrypted export with a key pattern
 * ```typescript
 * const autoExport = yield* AWS.DataExchange.EventAction("AutoExport", {
 *   dataSetId: entitledDataSetId,
 *   exportRevisionToS3: {
 *     bucket: landing.bucketName,
 *     keyPattern: "prices/${Revision.CreatedAt}/${Asset.Name}",
 *     encryption: { type: "aws:kms", kmsKeyArn: key.keyArn },
 *   },
 * });
 * ```
 */
export const EventAction = Resource<EventAction>(
  "AWS.DataExchange.EventAction",
);

const toWireAction = (props: EventActionProps): dataexchange.Action => ({
  ExportRevisionToS3: {
    RevisionDestination: {
      Bucket: props.exportRevisionToS3.bucket,
      KeyPattern: props.exportRevisionToS3.keyPattern,
    },
    Encryption: props.exportRevisionToS3.encryption
      ? {
          Type: props.exportRevisionToS3.encryption.type,
          KmsKeyArn: props.exportRevisionToS3.encryption.kmsKeyArn,
        }
      : undefined,
  },
});

const sameAction = (
  observed: dataexchange.Action | undefined,
  desired: dataexchange.Action,
): boolean => {
  const a = observed?.ExportRevisionToS3;
  const b = desired.ExportRevisionToS3;
  return (
    a !== undefined &&
    b !== undefined &&
    a.RevisionDestination.Bucket === b.RevisionDestination.Bucket &&
    (a.RevisionDestination.KeyPattern ?? undefined) ===
      (b.RevisionDestination.KeyPattern ?? undefined) &&
    (a.Encryption?.Type ?? undefined) === (b.Encryption?.Type ?? undefined) &&
    (a.Encryption?.KmsKeyArn ?? undefined) ===
      (b.Encryption?.KmsKeyArn ?? undefined)
  );
};

export const EventActionProvider = () =>
  Provider.effect(
    EventAction,
    Effect.gen(function* () {
      /** Get an event action by id; typed not-found → undefined. */
      const getById = Effect.fn(function* (eventActionId: string) {
        return yield* dataexchange
          .getEventAction({ EventActionId: eventActionId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /**
       * Scan the data set's event actions for one carrying our ownership
       * tags. Event action ids are server-generated, so recovery from a
       * lost output (state-persistence failure) goes through per-action tag
       * inspection.
       */
      const findByTags = Effect.fn(function* (id: string, dataSetId: string) {
        return yield* dataexchange.listEventActions
          .items({ EventSourceId: dataSetId })
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
        stables: ["eventActionId", "eventActionArn", "dataSetId"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const dataSetId = output?.dataSetId ?? olds?.dataSetId;
          const eventAction = output?.eventActionId
            ? yield* getById(output.eventActionId)
            : dataSetId !== undefined
              ? yield* findByTags(id, dataSetId)
              : undefined;
          if (eventAction === undefined) return undefined;
          const attrs = {
            eventActionId: eventAction.Id!,
            eventActionArn: eventAction.Arn!,
            dataSetId:
              eventAction.Event?.RevisionPublished?.DataSetId ?? dataSetId!,
          };
          const tags = yield* readDataExchangeTags(attrs.eventActionArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // The watched data set is the event action's identity.
          if ((news.dataSetId as string) !== (olds.dataSetId as string)) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const dataSetId = news.dataSetId as string;
          const desiredAction = toWireAction(news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — output ids are only a cache; fall back to a
          //    tag-ownership scan of the data set's event actions.
          let eventAction = output?.eventActionId
            ? yield* getById(output.eventActionId)
            : undefined;
          if (eventAction === undefined) {
            eventAction = yield* findByTags(id, dataSetId);
          }

          // 2. Ensure — create when missing.
          if (eventAction === undefined) {
            eventAction = yield* dataexchange.createEventAction({
              Action: desiredAction,
              Event: { RevisionPublished: { DataSetId: dataSetId } },
              Tags: desiredTags,
            });
          }

          // 3. Sync — the export destination is mutable in place. Only call
          //    the API on an actual delta.
          if (!sameAction(eventAction.Action, desiredAction)) {
            eventAction = yield* dataexchange.updateEventAction({
              EventActionId: eventAction.Id!,
              Action: desiredAction,
            });
          }

          // 3b. Sync tags against OBSERVED cloud tags (adoption-safe).
          yield* syncDataExchangeTags(eventAction.Arn!, desiredTags);

          yield* session.note(eventAction.Arn!);
          return {
            eventActionId: eventAction.Id!,
            eventActionArn: eventAction.Arn!,
            dataSetId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dataexchange
            .deleteEventAction({ EventActionId: output.eventActionId })
            .pipe(
              // Deletion is idempotent — a missing event action is success.
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e): boolean => e._tag === "ThrottlingException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(5),
                ]),
              }),
            );
        }),

        list: () =>
          dataexchange.listEventActions.items({}).pipe(
            // RevisionPublished is the only event type Data Exchange supports;
            // entries without it carry no data set identity, so skip them
            // rather than fabricate a dataSetId.
            Stream.filterMap((entry) =>
              entry.Event.RevisionPublished !== undefined
                ? Result.succeed({
                    eventActionId: entry.Id,
                    eventActionArn: entry.Arn,
                    dataSetId: entry.Event.RevisionPublished.DataSetId,
                  })
                : Result.failVoid,
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
