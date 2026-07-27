import * as ivs from "@distilled.cloud/aws/ivs";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  retryWhileThrottled,
  syncIvsTags,
  toTagRecord,
} from "./internal.ts";

export interface RecordingDestinationConfiguration {
  /**
   * S3 destination for recordings.
   */
  s3?: {
    /**
     * Name of the S3 bucket recordings are written to. Must be in the
     * same region and account as the recording configuration.
     */
    bucketName: string;
  };
}

export interface RecordingThumbnailConfiguration {
  /**
   * Thumbnail recording mode (`DISABLED` or `INTERVAL`).
   * @default "INTERVAL"
   */
  recordingMode?: "DISABLED" | "INTERVAL";
  /**
   * The targeted interval between thumbnails when `recordingMode` is
   * `INTERVAL`. Accepts any `Duration.Input` (e.g. `"60 seconds"`,
   * `Duration.minutes(2)`); converted to whole seconds on the wire.
   * Minimum 1 second, maximum 60 seconds when `storage` includes
   * `LATEST`.
   * @default 60 seconds
   */
  targetInterval?: Duration.Input;
  /**
   * Desired resolution of recorded thumbnails (`SD`, `HD`, `FULL_HD`, or
   * `LOWEST_RESOLUTION`).
   * @default the source resolution
   */
  resolution?: "SD" | "HD" | "FULL_HD" | "LOWEST_RESOLUTION";
  /**
   * Where thumbnails are stored: `SEQUENTIAL` archives all thumbnails,
   * `LATEST` keeps only the most recent (overwritten in place).
   * @default ["SEQUENTIAL"]
   */
  storage?: ("SEQUENTIAL" | "LATEST")[];
}

export interface RecordingRenditionConfiguration {
  /**
   * Which renditions are recorded (`ALL`, `NONE`, or `CUSTOM`).
   * @default "ALL"
   */
  renditionSelection?: "ALL" | "NONE" | "CUSTOM";
  /**
   * The renditions recorded when `renditionSelection` is `CUSTOM` (`SD`,
   * `HD`, `FULL_HD`, `LOWEST_RESOLUTION`).
   */
  renditions?: ("SD" | "HD" | "FULL_HD" | "LOWEST_RESOLUTION")[];
}

export interface RecordingConfigurationProps {
  /**
   * Where recordings are written (an S3 bucket in the same region and
   * account). Changing the destination replaces the recording
   * configuration.
   */
  destinationConfiguration: RecordingDestinationConfiguration;
  /**
   * Name of the recording configuration. If omitted, a deterministic
   * physical name is generated. There is no update operation, so
   * changing the name replaces the recording configuration.
   */
  recordingConfigurationName?: string;
  /**
   * If a broadcast disconnects and reconnects within this window, the
   * multiple streams are considered a single broadcast and merged into a
   * single recording. Accepts any `Duration.Input` (e.g. `"2 minutes"`,
   * `Duration.seconds(30)`); converted to whole seconds on the wire.
   * Maximum 5 minutes. Changing the window replaces the recording
   * configuration.
   * @default 0 seconds (no merge)
   */
  recordingReconnectWindow?: Duration.Input;
  /**
   * Thumbnail generation settings for the recording. Changing them
   * replaces the recording configuration.
   */
  thumbnailConfiguration?: RecordingThumbnailConfiguration;
  /**
   * Which renditions of the live stream are recorded. Changing them
   * replaces the recording configuration.
   */
  renditionConfiguration?: RecordingRenditionConfiguration;
  /**
   * Tags to apply to the recording configuration. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface RecordingConfiguration extends Resource<
  "AWS.IVS.RecordingConfiguration",
  RecordingConfigurationProps,
  {
    /**
     * ARN of the recording configuration.
     */
    recordingConfigurationArn: string;
    /**
     * The recording configuration's physical name.
     */
    recordingConfigurationName: string | undefined;
    /**
     * Name of the S3 bucket recordings are written to.
     */
    bucketName: string | undefined;
    /**
     * State of the recording configuration (`CREATING`, `ACTIVE`, or
     * `CREATE_FAILED`).
     */
    state: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon IVS recording configuration, enabling automatic recording of
 * live broadcasts to Amazon S3.
 *
 * Attach the configuration to a channel via the channel's
 * `recordingConfigurationArn` prop; every broadcast on that channel is
 * then archived to the configured bucket. Recording configurations are
 * immutable — any settings change replaces the resource.
 * @resource
 * @section Recording Broadcasts
 * @example Record a Channel to S3
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import * as IVS from "alchemy/AWS/IVS";
 *
 * const archive = yield* AWS.Bucket("StreamArchive");
 * const recording = yield* IVS.RecordingConfiguration("Recording", {
 *   destinationConfiguration: { s3: { bucketName: archive.bucketName } },
 * });
 * const channel = yield* IVS.Channel("LiveChannel", {
 *   recordingConfigurationArn: recording.recordingConfigurationArn,
 * });
 * ```
 *
 * @example Merge Reconnects and Record Thumbnails
 * ```typescript
 * const recording = yield* IVS.RecordingConfiguration("Recording", {
 *   destinationConfiguration: { s3: { bucketName: archive.bucketName } },
 *   recordingReconnectWindow: "2 minutes",
 *   thumbnailConfiguration: {
 *     recordingMode: "INTERVAL",
 *     targetInterval: "30 seconds",
 *   },
 * });
 * ```
 */
export const RecordingConfiguration = Resource<RecordingConfiguration>(
  "AWS.IVS.RecordingConfiguration",
);

/**
 * Raised when the IVS API returns a recording configuration in an
 * unusable shape or state (missing from a create response, or stuck in
 * `CREATE_FAILED`).
 */
export class IvsRecordingConfigurationFailed extends Data.TaggedError(
  "IvsRecordingConfigurationFailed",
)<{ message: string }> {}

export const RecordingConfigurationProvider = () =>
  Provider.effect(
    RecordingConfiguration,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { recordingConfigurationName?: string | undefined },
      ) =>
        props.recordingConfigurationName
          ? Effect.succeed(props.recordingConfigurationName)
          : createPhysicalName({ id, maxLength: 128 });

      const toAttrs = (config: {
        arn: string;
        name?: string | undefined;
        destinationConfiguration: ivs.DestinationConfiguration;
        state: string;
      }) => ({
        recordingConfigurationArn: config.arn,
        recordingConfigurationName: config.name,
        bucketName: config.destinationConfiguration.s3?.bucketName,
        state: config.state,
      });

      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* ivs.getRecordingConfiguration({ arn }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
        return response?.recordingConfiguration;
      });

      /**
       * ListRecordingConfigurations has no name filter — enumerate and
       * match exactly (names are not unique; first hit wins). Used only
       * when the output ARN cache is unavailable.
       */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* ivs.listRecordingConfigurations.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.recordingConfigurations),
          ),
          retryWhileThrottled,
        );
        const match = summaries.find((s) => s.name === name);
        return match === undefined ? undefined : yield* getByArn(match.arn);
      });

      /**
       * Wait (bounded) for a freshly created configuration to leave
       * `CREATING`. `CREATE_FAILED` (e.g. the bucket is in another
       * region) is surfaced as a typed failure.
       */
      const awaitActive = Effect.fn(function* (arn: string) {
        const config = yield* getByArn(arn).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("3 seconds"),
            until: (c): boolean => c === undefined || c.state !== "CREATING",
            times: 20,
          }),
        );
        if (config === undefined) {
          return yield* Effect.fail(
            new IvsRecordingConfigurationFailed({
              message: `IVS recording configuration '${arn}' vanished while awaiting ACTIVE`,
            }),
          );
        }
        if (config.state === "CREATE_FAILED") {
          return yield* Effect.fail(
            new IvsRecordingConfigurationFailed({
              message: `IVS recording configuration '${arn}' entered CREATE_FAILED — is the S3 bucket in the same region and account?`,
            }),
          );
        }
        return config;
      });

      return {
        stables: ["recordingConfigurationArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const config = output?.recordingConfigurationArn
            ? yield* getByArn(output.recordingConfigurationArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (config === undefined) return undefined;
          const attrs = toAttrs(config);
          return (yield* hasAlchemyTags(id, toTagRecord(config.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          // There is no UpdateRecordingConfiguration — every setting
          // except tags is immutable and requires a replacement.
          const changed =
            (yield* toName(id, olds)) !== (yield* toName(id, news)) ||
            olds.destinationConfiguration.s3?.bucketName !==
              news.destinationConfiguration.s3?.bucketName ||
            toWireSeconds(olds.recordingReconnectWindow) !==
              toWireSeconds(news.recordingReconnectWindow) ||
            JSON.stringify({
              ...olds.thumbnailConfiguration,
              targetInterval: toWireSeconds(
                olds.thumbnailConfiguration?.targetInterval,
              ),
            }) !==
              JSON.stringify({
                ...news.thumbnailConfiguration,
                targetInterval: toWireSeconds(
                  news.thumbnailConfiguration?.targetInterval,
                ),
              }) ||
            JSON.stringify(olds.renditionConfiguration) !==
              JSON.stringify(news.renditionConfiguration);
          if (changed) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — the live configuration is authoritative; the
          // output ARN is only an identifier cache.
          let observed = output?.recordingConfigurationArn
            ? yield* getByArn(output.recordingConfigurationArn)
            : yield* findByName(name);

          // 2. Ensure — create if missing, then wait for ACTIVE.
          if (observed === undefined) {
            const thumbnail = news.thumbnailConfiguration;
            const created = yield* ivs
              .createRecordingConfiguration({
                name,
                destinationConfiguration: news.destinationConfiguration,
                recordingReconnectWindowSeconds: toWireSeconds(
                  news.recordingReconnectWindow,
                ),
                thumbnailConfiguration:
                  thumbnail === undefined
                    ? undefined
                    : {
                        recordingMode: thumbnail.recordingMode,
                        targetIntervalSeconds: toWireSeconds(
                          thumbnail.targetInterval,
                        ),
                        resolution: thumbnail.resolution,
                        storage: thumbnail.storage,
                      },
                renditionConfiguration: news.renditionConfiguration,
                tags: desiredTags,
              })
              .pipe(retryWhileThrottled);
            observed = created.recordingConfiguration;
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new IvsRecordingConfigurationFailed({
                message:
                  "IVS CreateRecordingConfiguration returned no configuration",
              }),
            );
          }
          const arn = observed.arn;
          yield* session.note(arn);
          const active = yield* awaitActive(arn);

          // 3. Sync tags — the only mutable aspect. Diff against OBSERVED
          // cloud tags so adoption converges.
          yield* syncIvsTags(arn, desiredTags);

          // 4. Return fresh attributes.
          return toAttrs(active);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deleting a configuration still attached to a channel raises
          // ConflictException — retry through a bounded window, then
          // tolerate already-gone.
          yield* ivs
            .deleteRecordingConfiguration({
              arn: output.recordingConfigurationArn,
            })
            .pipe(
              retryWhileThrottled,
              retryWhileConflict,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          ivs.listRecordingConfigurations.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.recordingConfigurations),
            ),
            Effect.map((summaries) =>
              summaries.map((summary) => toAttrs(summary)),
            ),
          ),
      };
    }),
  );
