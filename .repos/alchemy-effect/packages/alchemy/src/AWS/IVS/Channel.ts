import * as ivs from "@distilled.cloud/aws/ivs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  retryWhileThrottled,
  syncIvsTags,
  toTagRecord,
} from "./internal.ts";

export interface ChannelProps {
  /**
   * Name of the channel (letters, digits, `-` and `_`; not unique across
   * channels). If omitted, a deterministic physical name is generated.
   * Channel names are mutable — changing the name updates the channel in
   * place.
   */
  channelName?: string;
  /**
   * Channel latency mode. `LOW` enables low-latency live video (~3s);
   * `NORMAL` broadcasts at higher latency for a lower cost.
   * @default "LOW"
   */
  latencyMode?: "NORMAL" | "LOW";
  /**
   * Channel type, which determines the allowable resolution and bitrate
   * of the delivered video (e.g. `STANDARD`, `BASIC`, `ADVANCED_SD`,
   * `ADVANCED_HD`).
   * @default "STANDARD"
   */
  type?: string;
  /**
   * Whether the channel is private (viewers require a playback
   * authorization token generated with a `PlaybackKeyPair`).
   * @default false
   */
  authorized?: boolean;
  /**
   * ARN of a recording configuration to record live broadcasts to S3.
   * @default no recording
   */
  recordingConfigurationArn?: string;
  /**
   * Whether the channel allows insecure RTMP ingest.
   * @default false
   */
  insecureIngest?: boolean;
  /**
   * Optional transcode preset for `ADVANCED_SD`/`ADVANCED_HD` channel
   * types (`HIGHER_BANDWIDTH_DELIVERY` or `CONSTRAINED_BANDWIDTH_DELIVERY`).
   */
  preset?: string;
  /**
   * ARN of a playback restriction policy constraining playback by
   * country and/or origin.
   */
  playbackRestrictionPolicyArn?: string;
  /**
   * Tags to apply to the channel. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Channel extends Resource<
  "AWS.IVS.Channel",
  ChannelProps,
  {
    /**
     * The channel's physical name.
     */
    channelName: string;
    /**
     * ARN of the channel.
     */
    channelArn: string;
    /**
     * RTMPS ingest endpoint broadcast software sends video to
     * (authenticated with a `StreamKey`).
     */
    ingestEndpoint: string;
    /**
     * Playback URL viewers use to watch the channel's live stream.
     */
    playbackUrl: string;
    /**
     * Channel type (resolution/bitrate tier) reported by IVS.
     */
    type: string | undefined;
    /**
     * Latency mode reported by IVS (`LOW` or `NORMAL`).
     */
    latencyMode: string | undefined;
    /**
     * Whether playback requires a signed authorization token.
     */
    authorized: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon IVS (Interactive Video Service) channel for low-latency live
 * video streaming.
 *
 * A channel stores configuration for broadcasting live streams: broadcast
 * software sends video to the channel's `ingestEndpoint` (authenticated
 * with a `StreamKey`) and viewers watch via the channel's `playbackUrl`.
 * @resource
 * @section Creating Channels
 * @example Basic Channel
 * ```typescript
 * import * as IVS from "alchemy/AWS/IVS";
 *
 * const channel = yield* IVS.Channel("LiveChannel");
 * ```
 *
 * @example Basic Low-Cost Channel
 * ```typescript
 * const channel = yield* IVS.Channel("LiveChannel", {
 *   type: "BASIC",
 *   latencyMode: "NORMAL",
 * });
 * ```
 *
 * @section Private Channels
 * @example Channel with Playback Authorization
 * ```typescript
 * const channel = yield* IVS.Channel("PrivateChannel", {
 *   authorized: true,
 * });
 * ```
 *
 * @section Streaming
 * @example Channel with a Stream Key
 * ```typescript
 * const channel = yield* IVS.Channel("LiveChannel");
 * const streamKey = yield* IVS.StreamKey("LiveKey", {
 *   channelArn: channel.channelArn,
 * });
 * // broadcast to rtmps://{channel.ingestEndpoint}:443/app/ with streamKey.value
 * ```
 */
export const Channel = Resource<Channel>("AWS.IVS.Channel");

/**
 * Raised when the IVS API returns a channel that is missing its ARN, name,
 * ingest endpoint, or playback URL.
 */
export class IvsChannelIncomplete extends Data.TaggedError(
  "IvsChannelIncomplete",
)<{ message: string }> {}

export const ChannelProvider = () =>
  Provider.effect(
    Channel,
    Effect.gen(function* () {
      const toName = (id: string, props: ChannelProps) =>
        props.channelName
          ? Effect.succeed(props.channelName)
          : createPhysicalName({ id, maxLength: 128 });

      const toAttrs = Effect.fn(function* (channel: ivs.Channel) {
        if (
          !channel.arn ||
          !channel.name ||
          channel.ingestEndpoint === undefined ||
          channel.playbackUrl === undefined
        ) {
          return yield* Effect.fail(
            new IvsChannelIncomplete({
              message:
                "IVS channel is missing its ARN, name, ingest endpoint, or playback URL",
            }),
          );
        }
        return {
          channelName: channel.name,
          channelArn: channel.arn,
          ingestEndpoint: channel.ingestEndpoint,
          playbackUrl: channel.playbackUrl,
          type: channel.type,
          latencyMode: channel.latencyMode,
          authorized: channel.authorized,
        };
      });

      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* ivs.getChannel({ arn }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
        return response?.channel;
      });

      /**
       * Channel names are not unique — `filterByName` narrows server-side
       * and we match exactly, taking the first hit. Used only when the
       * output ARN cache is unavailable (state-persistence failure).
       */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* ivs.listChannels
          .pages({ filterByName: name })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.channels),
            ),
            retryWhileThrottled,
          );
        const match = summaries.find((s) => s.name === name && s.arn);
        return match?.arn ? yield* getByArn(match.arn) : undefined;
      });

      return {
        stables: ["channelArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const channel = output?.channelArn
            ? yield* getByArn(output.channelArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (channel === undefined) return undefined;
          const attrs = yield* toAttrs(channel);
          return (yield* hasAlchemyTags(id, toTagRecord(channel.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — the live channel is authoritative; the output ARN
          // is only an identifier cache.
          let observed = output?.channelArn
            ? yield* getByArn(output.channelArn)
            : yield* findByName(name);

          // 2. Ensure — create if missing. CreateChannel also provisions
          // the channel's default stream key, which we leave in place (see
          // the StreamKey resource).
          if (observed === undefined) {
            const created = yield* ivs
              .createChannel({
                name,
                latencyMode: news.latencyMode,
                type: news.type,
                authorized: news.authorized,
                recordingConfigurationArn: news.recordingConfigurationArn,
                insecureIngest: news.insecureIngest,
                preset: news.preset,
                playbackRestrictionPolicyArn: news.playbackRestrictionPolicyArn,
                tags: desiredTags,
              })
              .pipe(retryWhileThrottled);
            observed = created.channel;
          }
          const arn = observed?.arn;
          if (observed === undefined || arn === undefined) {
            return yield* Effect.fail(
              new IvsChannelIncomplete({
                message: "IVS CreateChannel returned no channel ARN",
              }),
            );
          }

          // 3. Sync — diff observed against desired for each prop the user
          // specified and apply only the delta. All channel settings
          // (including the name) are mutable via UpdateChannel.
          const patch: Partial<ivs.UpdateChannelRequest> = {};
          if (observed.name !== name) patch.name = name;
          if (
            news.latencyMode !== undefined &&
            observed.latencyMode !== news.latencyMode
          ) {
            patch.latencyMode = news.latencyMode;
          }
          if (news.type !== undefined && observed.type !== news.type) {
            patch.type = news.type;
          }
          if (
            news.authorized !== undefined &&
            observed.authorized !== news.authorized
          ) {
            patch.authorized = news.authorized;
          }
          if (
            news.recordingConfigurationArn !== undefined &&
            observed.recordingConfigurationArn !==
              news.recordingConfigurationArn
          ) {
            patch.recordingConfigurationArn = news.recordingConfigurationArn;
          }
          if (
            news.insecureIngest !== undefined &&
            observed.insecureIngest !== news.insecureIngest
          ) {
            patch.insecureIngest = news.insecureIngest;
          }
          if (news.preset !== undefined && observed.preset !== news.preset) {
            patch.preset = news.preset;
          }
          if (
            news.playbackRestrictionPolicyArn !== undefined &&
            observed.playbackRestrictionPolicyArn !==
              news.playbackRestrictionPolicyArn
          ) {
            patch.playbackRestrictionPolicyArn =
              news.playbackRestrictionPolicyArn;
          }
          if (Object.keys(patch).length > 0) {
            yield* ivs
              .updateChannel({ arn, ...patch })
              .pipe(retryWhileThrottled, retryWhileConflict);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags so adoption
          // converges.
          yield* syncIvsTags(arn, desiredTags);

          // 4. Return fresh attributes.
          const final = yield* getByArn(arn);
          if (final === undefined) {
            return yield* Effect.fail(
              new IvsChannelIncomplete({
                message: `IVS channel '${arn}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(arn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteChannel raises ConflictException while a stream is live
          // — retry through a bounded window, then tolerate already-gone.
          yield* ivs.deleteChannel({ arn: output.channelArn }).pipe(
            retryWhileThrottled,
            retryWhileConflict,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),

        list: () =>
          ivs.listChannels.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.channels),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  summary.arn === undefined
                    ? Effect.succeed(undefined)
                    : getByArn(summary.arn).pipe(
                        Effect.flatMap((channel) =>
                          channel === undefined
                            ? Effect.succeed(undefined)
                            : toAttrs(channel),
                        ),
                      ),
                { concurrency: 5 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
