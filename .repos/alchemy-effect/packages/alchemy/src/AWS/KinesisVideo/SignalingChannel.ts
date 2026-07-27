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
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  compactTags,
  retryWhileResourceInUse,
  retryWhileSettling,
  waitForChannelActive,
  waitForChannelGone,
} from "./internal.ts";

export interface SignalingChannelProps {
  /**
   * Name of the signaling channel. Changing the name replaces the channel.
   * Must be unique per account and region.
   * @default a generated physical name
   */
  channelName?: string;
  /**
   * The type of the channel. `SINGLE_MASTER` is the only fully supported
   * type. Changing the type replaces the channel.
   * @default "SINGLE_MASTER"
   */
  type?: "SINGLE_MASTER" | "FULL_MESH";
  /**
   * How long an undelivered signaling message is retained (5–120 seconds).
   * Accepts any `Duration.Input` (e.g. `"30 seconds"`, `Duration.seconds(30)`;
   * a bare number is milliseconds); the wire unit is whole seconds. Updated
   * in place.
   * @default 60 seconds
   */
  messageTtl?: Duration.Input;
  /**
   * Tags to apply to the channel. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface SignalingChannel extends Resource<
  "AWS.KinesisVideo.SignalingChannel",
  SignalingChannelProps,
  {
    channelName: string;
    channelArn: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon Kinesis Video Streams WebRTC signaling channel — the rendezvous
 * point that WebRTC master and viewer peers use to exchange SDP offers,
 * answers, and ICE candidates.
 *
 * `messageTtl` is updated in place; changing `channelName` or `type`
 * replaces the channel.
 * @resource
 * @section Creating Channels
 * @example Basic Signaling Channel
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const channel = yield* AWS.KinesisVideo.SignalingChannel("Doorbell");
 * ```
 *
 * @example Channel with Message TTL
 * ```typescript
 * const channel = yield* AWS.KinesisVideo.SignalingChannel("Doorbell", {
 *   messageTtl: "30 seconds",
 *   tags: { Environment: "production" },
 * });
 * ```
 *
 * @section WebRTC Connectivity
 * @example ICE Server Configuration
 * ```typescript
 * // init
 * const getIceServers = yield* AWS.KinesisVideo.GetIceServerConfig(channel);
 *
 * // runtime — TURN URIs + short-lived credentials for a WebRTC peer
 * const { IceServerList } = yield* getIceServers({ ClientId: "viewer-1" });
 * ```
 */
export const SignalingChannel = Resource<SignalingChannel>(
  "AWS.KinesisVideo.SignalingChannel",
);

export const SignalingChannelProvider = () =>
  Provider.effect(
    SignalingChannel,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { channelName?: string | undefined },
      ) {
        return (
          props.channelName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const observeChannel = Effect.fn(function* (channelName: string) {
        return yield* kv
          .describeSignalingChannel({ ChannelName: channelName })
          .pipe(
            Effect.map((r) => r.ChannelInfo),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const fetchObservedTags = Effect.fn(function* (channelArn: string) {
        return yield* kv.listTagsForResource({ ResourceARN: channelArn }).pipe(
          Effect.map((r) => compactTags(r.Tags)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      return SignalingChannel.Provider.of({
        stables: ["channelName", "channelArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* kv.listSignalingChannels
              .pages({})
              .pipe(Stream_.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.ChannelInfoList ?? [])
              .filter(
                (info) =>
                  info.ChannelName !== undefined &&
                  info.ChannelARN !== undefined,
              )
              .map((info) => ({
                channelName: info.ChannelName!,
                channelArn: info.ChannelARN!,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const channelName =
            output?.channelName ?? (yield* createName(id, olds ?? {}));
          const info = yield* observeChannel(channelName);
          if (
            info?.ChannelARN === undefined ||
            info.ChannelStatus === "DELETING"
          ) {
            return undefined;
          }
          const attrs = {
            channelName,
            channelArn: info.ChannelARN,
          };
          const tags = yield* fetchObservedTags(info.ChannelARN);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The channel type is bound at creation and cannot change in place.
          const oldType = olds?.type ?? "SINGLE_MASTER";
          const newType = news?.type ?? "SINGLE_MASTER";
          if (oldType !== newType) {
            return { action: "replace" } as const;
          }
          // messageTtl/tags fall through to the default update path.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // `news` is undefined when the resource is declared without props
          // (`SignalingChannel("Id")`) — normalize WITHOUT a destructuring
          // default (defaults widen the inferred Props type).
          const props = news ?? {};
          const channelName =
            output?.channelName ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          // Wire unit is whole seconds (MessageTtlSeconds).
          const desiredTtl = toWireSeconds(props.messageTtl);

          // 1. OBSERVE
          let info = yield* observeChannel(channelName);

          // A previous incarnation still in DELETING blocks re-creation of
          // the same name — wait for the purge to finish, then recreate.
          if (info?.ChannelStatus === "DELETING") {
            yield* session.note(
              `waiting for previous channel ${channelName} to finish deleting...`,
            );
            yield* waitForChannelGone(channelName);
            info = undefined;
          }

          // 2. ENSURE — create if missing; tolerate the concurrent-create
          // race and wait for ACTIVE (creation is async but fast).
          if (info === undefined) {
            yield* retryWhileResourceInUse(
              kv.createSignalingChannel({
                ChannelName: channelName,
                ChannelType: props.type ?? "SINGLE_MASTER",
                SingleMasterConfiguration:
                  desiredTtl !== undefined
                    ? { MessageTtlSeconds: desiredTtl }
                    : undefined,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            ).pipe(
              Effect.catchTag("ResourceInUseException", () =>
                Effect.succeed({ ChannelARN: undefined }),
              ),
            );
            yield* session.note(`creating signaling channel ${channelName}...`);
            info = yield* waitForChannelActive(channelName);
          } else if (info.ChannelStatus !== "ACTIVE") {
            info = yield* waitForChannelActive(channelName);
          }
          const channelArn = info.ChannelARN!;

          // 3. SYNC — message TTL (versioned update; only on observed drift)
          const observedTtl = info.SingleMasterConfiguration?.MessageTtlSeconds;
          if (desiredTtl !== undefined && desiredTtl !== observedTtl) {
            yield* retryWhileSettling(
              kv.updateSignalingChannel({
                ChannelARN: channelArn,
                CurrentVersion: info.Version!,
                SingleMasterConfiguration: { MessageTtlSeconds: desiredTtl },
              }),
            );
            // UpdateSignalingChannel is async: wait for the version bump AND
            // ACTIVE before any further versioned mutation.
            info = yield* waitForChannelActive(channelName, info.Version);
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags
          const observedTags = yield* fetchObservedTags(channelArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* retryWhileSettling(
              kv.tagResource({
                ResourceARN: channelArn,
                Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
              }),
            );
          }
          if (removed.length > 0) {
            yield* retryWhileSettling(
              kv.untagResource({
                ResourceARN: channelArn,
                TagKeyList: removed,
              }),
            );
          }

          yield* session.note(channelArn);
          return { channelName, channelArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A CREATING/UPDATING channel rejects deletion with
          // ResourceInUseException — retry through the transition (bounded).
          yield* retryWhileResourceInUse(
            kv.deleteSignalingChannel({ ChannelARN: output.channelArn }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
