import * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream_ from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireHours } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  compactTags,
  retryWhileResourceInUse,
  retryWhileSettling,
  waitForStreamActive,
  waitForStreamGone,
} from "./internal.ts";

export interface StreamProps {
  /**
   * Name of the video stream. Changing the name replaces the stream.
   * Must be unique per account and region.
   * @default a generated physical name
   */
  streamName?: string;
  /**
   * Name of the device that writes to the stream. Kinesis Video Streams
   * does not currently use this name, but it is stored with the stream
   * metadata and can be updated in place.
   */
  deviceName?: string;
  /**
   * Media type of the stream as a MIME type (e.g. `video/h264`). Consumers
   * can use it to determine how to process the stream. Updated in place.
   */
  mediaType?: string;
  /**
   * The ID (or alias/ARN) of the KMS key used to encrypt stream data.
   * Changing the key replaces the stream.
   * @default the AWS-managed `aws/kinesisvideo` key
   */
  kmsKeyId?: string;
  /**
   * How long stream data is retained. Zero duration means no retention —
   * data is only available live. Accepts any `Duration.Input` (e.g.
   * `"24 hours"`, `Duration.hours(24)`; a bare number is milliseconds); the
   * wire unit is whole hours. Adjusted in place via `UpdateDataRetention`.
   * @default 0
   */
  dataRetention?: Duration.Input;
  /**
   * Tags to apply to the stream. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Stream extends Resource<
  "AWS.KinesisVideo.Stream",
  StreamProps,
  {
    streamName: string;
    streamArn: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon Kinesis Video Stream for ingesting, storing, and consuming
 * live video.
 *
 * Stream creation is asynchronous — the provider waits (bounded) for the
 * stream to become `ACTIVE` before returning. `deviceName` and `mediaType`
 * are updated in place; `dataRetention` converges via `UpdateDataRetention`;
 * changing `streamName` or `kmsKeyId` replaces the stream.
 * @resource
 * @section Creating Streams
 * @example Basic Video Stream
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const stream = yield* AWS.KinesisVideo.Stream("Camera");
 * ```
 *
 * @example Stream with Retention and Media Type
 * ```typescript
 * const stream = yield* AWS.KinesisVideo.Stream("Camera", {
 *   mediaType: "video/h264",
 *   dataRetention: "24 hours",
 *   tags: { Environment: "production" },
 * });
 * ```
 *
 * @section Reading Media
 * Bind data-plane read operations in the init phase and use them in
 * runtime handlers. The bindings resolve the per-stream data endpoint
 * (`GetDataEndpoint`) automatically.
 *
 * @example HLS Playback URL
 * ```typescript
 * // init
 * const getHls = yield* AWS.KinesisVideo.GetHLSStreamingSessionURL(stream);
 *
 * // runtime
 * const { HLSStreamingSessionURL } = yield* getHls({ PlaybackMode: "LIVE" });
 * ```
 *
 * @example Raw Media
 * ```typescript
 * // init
 * const getMedia = yield* AWS.KinesisVideo.GetMedia(stream);
 *
 * // runtime
 * const media = yield* getMedia({
 *   StartSelector: { StartSelectorType: "EARLIEST" },
 * });
 * ```
 */
export const Stream = Resource<Stream>("AWS.KinesisVideo.Stream");

export const StreamProvider = () =>
  Provider.effect(
    Stream,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { streamName?: string | undefined },
      ) {
        return (
          props.streamName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const observeStream = Effect.fn(function* (streamName: string) {
        return yield* kv.describeStream({ StreamName: streamName }).pipe(
          Effect.map((r) => r.StreamInfo),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const fetchObservedTags = Effect.fn(function* (streamArn: string) {
        return yield* kv.listTagsForStream({ StreamARN: streamArn }).pipe(
          Effect.map((r) => compactTags(r.Tags)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      return Stream.Provider.of({
        stables: ["streamName", "streamArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* kv.listStreams
              .pages({})
              .pipe(Stream_.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.StreamInfoList ?? [])
              .filter(
                (info) =>
                  info.StreamName !== undefined && info.StreamARN !== undefined,
              )
              .map((info) => ({
                streamName: info.StreamName!,
                streamArn: info.StreamARN!,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const streamName =
            output?.streamName ?? (yield* createName(id, olds ?? {}));
          const info = yield* observeStream(streamName);
          if (info?.StreamARN === undefined || info.Status === "DELETING") {
            return undefined;
          }
          const attrs = {
            streamName,
            streamArn: info.StreamARN,
          };
          const tags = yield* fetchObservedTags(info.StreamARN);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The KMS key is bound at creation and cannot be changed in place.
          if (olds?.kmsKeyId !== news?.kmsKeyId) {
            return { action: "replace" } as const;
          }
          // deviceName/mediaType/dataRetention/tags fall through to
          // the default update path (reconcile applies the deltas).
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // `news` is undefined when the resource is declared without props
          // (`Stream("Id")`) — normalize WITHOUT a destructuring default
          // (defaults widen the inferred Props type).
          const props = news ?? {};
          const streamName =
            output?.streamName ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          // Wire unit is whole hours (DataRetentionInHours).
          const desiredRetention = toWireHours(props.dataRetention);

          // 1. OBSERVE — cloud state is authoritative
          let info = yield* observeStream(streamName);

          // A previous incarnation still in DELETING blocks re-creation of
          // the same name — wait for the purge to finish, then recreate.
          if (info?.Status === "DELETING") {
            yield* session.note(
              `waiting for previous stream ${streamName} to finish deleting...`,
            );
            yield* waitForStreamGone(streamName);
            info = undefined;
          }

          // 2. ENSURE — create if missing; a `ResourceInUseException` means a
          // peer created it concurrently (or a prior incarnation is still
          // DELETING — retried inside the helper), so fall through to
          // observation. Creation is async; wait for ACTIVE (bounded).
          if (info === undefined) {
            yield* retryWhileResourceInUse(
              kv.createStream({
                StreamName: streamName,
                DeviceName: props.deviceName,
                MediaType: props.mediaType,
                KmsKeyId: props.kmsKeyId,
                DataRetentionInHours: desiredRetention ?? 0,
                Tags: desiredTags,
              }),
            ).pipe(
              Effect.catchTag("ResourceInUseException", () =>
                Effect.succeed({ StreamARN: undefined }),
              ),
            );
            yield* session.note(`creating stream ${streamName}...`);
            info = yield* waitForStreamActive(streamName);
          } else if (info.Status !== "ACTIVE") {
            // A CREATING/UPDATING stream rejects mutations — wait it out.
            info = yield* waitForStreamActive(streamName);
          }
          const streamArn = info.StreamARN!;

          // 3. SYNC — deviceName/mediaType (versioned update; only when the
          // observed metadata differs from the desired state)
          if (
            (props.deviceName !== undefined &&
              props.deviceName !== info.DeviceName) ||
            (props.mediaType !== undefined &&
              props.mediaType !== info.MediaType)
          ) {
            yield* retryWhileSettling(
              kv.updateStream({
                StreamARN: streamArn,
                CurrentVersion: info.Version!,
                DeviceName: props.deviceName,
                MediaType: props.mediaType,
              }),
            );
            // UpdateStream is async: it bumps the version and transitions
            // through UPDATING. Wait for BOTH the version bump and ACTIVE so
            // the next versioned mutation uses a fresh version.
            info = yield* waitForStreamActive(streamName, info.Version);
          }

          // 3b. SYNC — data retention (delta-based API: INCREASE/DECREASE by
          // the difference between observed and desired)
          const observedRetention = info.DataRetentionInHours ?? 0;
          if (
            desiredRetention !== undefined &&
            desiredRetention !== observedRetention
          ) {
            yield* retryWhileSettling(
              kv.updateDataRetention({
                StreamARN: streamArn,
                CurrentVersion: info.Version!,
                Operation:
                  desiredRetention > observedRetention
                    ? "INCREASE_DATA_RETENTION"
                    : "DECREASE_DATA_RETENTION",
                DataRetentionChangeInHours: Math.abs(
                  desiredRetention - observedRetention,
                ),
              }),
            );
            info = yield* waitForStreamActive(streamName, info.Version);
          }

          // 3c. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          // converges
          const observedTags = yield* fetchObservedTags(streamArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* retryWhileSettling(
              kv.tagStream({
                StreamARN: streamArn,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              }),
            );
          }
          if (removed.length > 0) {
            yield* retryWhileSettling(
              kv.untagStream({
                StreamARN: streamArn,
                TagKeyList: removed,
              }),
            );
          }

          yield* session.note(streamArn);
          return { streamName, streamArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A CREATING/UPDATING stream rejects deletion with
          // ResourceInUseException — retry through the transition (bounded).
          yield* retryWhileResourceInUse(
            kv.deleteStream({ StreamARN: output.streamArn }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
