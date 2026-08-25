import * as translate from "@distilled.cloud/aws/translate";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readTranslateTags, syncTranslateTags } from "./internal.ts";

/**
 * The parallel data import failed server-side (`Status: FAILED`) — usually a
 * malformed input file or an S3 URI the caller cannot read.
 */
export class ParallelDataFailed extends Data.TaggedError("ParallelDataFailed")<{
  readonly name: string;
  readonly message: string | undefined;
}> {}

/**
 * The parallel data did not reach a terminal status within the bounded
 * polling window.
 */
export class ParallelDataNotConverged extends Data.TaggedError(
  "ParallelDataNotConverged",
)<{
  readonly name: string;
  readonly status: string | undefined;
}> {}

export interface ParallelDataProps {
  /**
   * Name of the parallel data — up to 256 characters of letters, digits, and
   * hyphens (`^([A-Za-z0-9-]_?)+$`). If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * parallel data.
   */
  parallelDataName?: string;
  /**
   * Description of the parallel data.
   */
  description?: string;
  /**
   * S3 URI of the parallel data input file (e.g.
   * `s3://my-bucket/examples.csv`). The caller must be able to read the
   * object. Updatable in place — a new import runs on change.
   */
  s3Uri: string;
  /**
   * Format of the input file: `TSV`, `CSV`, or `TMX`.
   */
  format?: "TSV" | "CSV" | "TMX";
  /**
   * Id of the customer-managed KMS key used to encrypt the parallel data.
   * If omitted, Translate uses an AWS-owned key.
   */
  encryptionKeyId?: string;
  /**
   * User-defined tags for the parallel data.
   */
  tags?: Record<string, string>;
}

export interface ParallelData extends Resource<
  "AWS.Translate.ParallelData",
  ParallelDataProps,
  {
    /**
     * Name of the parallel data — pass it as `ParallelDataNames` to
     * `StartTextTranslationJob` for Active Custom Translation.
     */
    parallelDataName: string;
    /**
     * ARN of the parallel data, e.g.
     * `arn:aws:translate:us-east-1:123456789012:parallel-data/style-examples`.
     */
    parallelDataArn: string;
    /** Status of the parallel data (`ACTIVE` once import succeeds). */
    status: string | undefined;
    /** Source language code detected from the input file, e.g. `en`. */
    sourceLanguageCode: string | undefined;
    /** Target language codes detected from the input file. */
    targetLanguageCodes: string[] | undefined;
    /** Number of records imported. */
    importedRecordCount: number | undefined;
    /** Number of records that failed to import. */
    failedRecordCount: number | undefined;
  },
  never,
  Providers
> {}

/**
 * Amazon Translate parallel data — segment-aligned translation examples
 * imported from S3 that steer the style, tone, and word choice of batch
 * translation jobs (Active Custom Translation). The import is asynchronous:
 * the resource waits for the parallel data to become `ACTIVE`.
 *
 * @resource
 * @section Managing Parallel Data
 * @example Import parallel data from S3
 * ```typescript
 * const examples = yield* AWS.Translate.ParallelData("StyleExamples", {
 *   s3Uri: "s3://my-bucket/style-examples.csv",
 *   format: "CSV",
 * });
 * ```
 *
 * @example Use parallel data in a batch translation job
 * ```typescript
 * const startJob = yield* AWS.Translate.StartTextTranslationJob(dataAccessRole);
 * yield* startJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", ContentType: "text/plain" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   SourceLanguageCode: "en",
 *   TargetLanguageCodes: ["es"],
 *   ParallelDataNames: [examples.parallelDataName],
 * });
 * ```
 */
export const ParallelData = Resource<ParallelData>(
  "AWS.Translate.ParallelData",
);

const toAttributes = (props: translate.ParallelDataProperties) => ({
  parallelDataName: props.Name!,
  parallelDataArn: props.Arn!,
  status: props.Status,
  sourceLanguageCode: props.SourceLanguageCode,
  targetLanguageCodes: props.TargetLanguageCodes
    ? [...props.TargetLanguageCodes]
    : undefined,
  importedRecordCount: props.ImportedRecordCount,
  failedRecordCount: props.FailedRecordCount,
});

export const ParallelDataProvider = () =>
  Provider.effect(
    ParallelData,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: ParallelDataProps,
      ) {
        return (
          props.parallelDataName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const getOne = Effect.fn(function* (name: string) {
        return yield* translate
          .getParallelData({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // The import runs asynchronously (CREATING/UPDATING → ACTIVE|FAILED);
      // poll bounded (~10 min ceiling — small files typically converge in a
      // few minutes).
      const waitForStable = Effect.fn(function* (name: string) {
        const final = yield* getOne(name).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (r): boolean => {
              const status = r?.ParallelDataProperties?.Status;
              return (
                r === undefined || status === "ACTIVE" || status === "FAILED"
              );
            },
            times: 60,
          }),
        );
        const props = final?.ParallelDataProperties;
        if (props?.Status === "FAILED") {
          return yield* Effect.fail(
            new ParallelDataFailed({ name, message: props.Message }),
          );
        }
        if (props?.Status !== "ACTIVE") {
          return yield* Effect.fail(
            new ParallelDataNotConverged({ name, status: props?.Status }),
          );
        }
        return props;
      });

      return {
        stables: ["parallelDataName", "parallelDataArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* createName(id, olds)) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.parallelDataName ??
            (yield* createName(id, olds ?? { s3Uri: "" }));
          const found = yield* getOne(name);
          if (found?.ParallelDataProperties === undefined) return undefined;
          const attrs = toAttributes(found.ParallelDataProperties);
          const tags = yield* readTranslateTags(attrs.parallelDataArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.parallelDataName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative.
          const observed = yield* getOne(name);
          const observedProps = observed?.ParallelDataProperties;

          if (observedProps === undefined) {
            // Ensure — greenfield import. ConflictException is a race with a
            // concurrent create of the same name; fall through to observe.
            // The client token only needs to be unique per submission;
            // idempotency across crashed runs comes from observing first.
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            yield* translate
              .createParallelData({
                Name: name,
                ClientToken: clientToken,
                Description: news.description,
                ParallelDataConfig: { S3Uri: news.s3Uri, Format: news.format },
                EncryptionKey: news.encryptionKeyId
                  ? { Type: "KMS", Id: news.encryptionKeyId }
                  : undefined,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
          } else {
            // Sync — diff the observed import config against the desired one
            // and re-import only on drift.
            const config = observedProps.ParallelDataConfig;
            const drift =
              config?.S3Uri !== news.s3Uri ||
              (news.format !== undefined && config?.Format !== news.format) ||
              (observedProps.Description ?? undefined) !==
                (news.description ?? undefined);
            if (drift) {
              // Computed outside the retry so replays of the same submission
              // reuse one idempotency token.
              const clientToken = yield* Effect.sync(() => crypto.randomUUID());
              yield* translate
                .updateParallelData({
                  Name: name,
                  ClientToken: clientToken,
                  Description: news.description,
                  ParallelDataConfig: {
                    S3Uri: news.s3Uri,
                    Format: news.format,
                  },
                })
                .pipe(
                  // A concurrent import may still be settling — retry bounded.
                  Effect.retry({
                    while: (e): boolean =>
                      e._tag === "ConcurrentModificationException" ||
                      e._tag === "ConflictException",
                    schedule: Schedule.spaced("10 seconds"),
                    times: 8,
                  }),
                );
            }
          }

          yield* session.note(name);
          const props = yield* waitForStable(name);
          yield* syncTranslateTags(props.Arn!, desiredTags);
          return toAttributes(props);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the parallel data may already be gone. A delete
          // during CREATING/UPDATING conflicts; retry bounded.
          yield* translate
            .deleteParallelData({ Name: output.parallelDataName })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "ConcurrentModificationException",
                schedule: Schedule.spaced("10 seconds"),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          // Deletion is asynchronous (DELETING) — wait until gone so a
          // replacement can immediately reuse the name.
          yield* translate
            .getParallelData({ Name: output.parallelDataName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (r): boolean => r === undefined,
                times: 36,
              }),
            );
        }),

        list: () =>
          translate.listParallelData.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ParallelDataPropertiesList ?? [])
                .filter((props) => props.Name && props.Arn)
                .map(toAttributes),
            ),
          ),
      };
    }),
  );
