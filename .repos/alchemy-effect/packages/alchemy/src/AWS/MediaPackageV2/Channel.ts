import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteChannelWithEndpoints,
  listAllChannelGroups,
  listGroupChannels,
  matchesDesired,
  policiesEqual,
  syncMpTags,
  toMpTagRecord,
} from "./internal.ts";

export interface ChannelProps {
  /**
   * Name of the channel group the channel belongs to. Changing it replaces
   * the channel.
   */
  channelGroupName: string;
  /**
   * Name of the channel. Must be unique within the channel group and match
   * `^[a-zA-Z0-9_-]+$`. If omitted, a unique name is generated. Changing the
   * name replaces the channel.
   */
  channelName?: string;
  /**
   * The input type of content the channel receives: `HLS` or `CMAF`.
   * Immutable — changing it replaces the channel.
   * @default "HLS"
   */
  inputType?: mediapackagev2.InputType;
  /**
   * Optional description of the channel (up to 1024 characters).
   */
  description?: string;
  /**
   * Input-switching behavior between the channel's redundant ingest inputs
   * (e.g. switch based on the media quality confidence score).
   */
  inputSwitchConfiguration?: mediapackagev2.InputSwitchConfiguration;
  /**
   * Settings for what common media server data (CMSD) headers AWS Elemental
   * MediaPackage includes in responses to the CDN.
   */
  outputHeaderConfiguration?: mediapackagev2.OutputHeaderConfiguration;
  /**
   * IAM resource policy (JSON) attached to the channel, controlling which
   * principals may push content to it (`mediapackagev2:PutObject`).
   * Omitting it removes any existing policy.
   */
  policy?: string;
  /**
   * User-defined tags for the channel. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Channel extends Resource<
  "AWS.MediaPackageV2.Channel",
  ChannelProps,
  {
    /** Name of the channel group the channel belongs to. */
    channelGroupName: string;
    /** Name of the channel. */
    channelName: string;
    /** ARN of the channel. */
    channelArn: string;
    /** Ingest container type (`HLS` or `CMAF`). */
    inputType: string | undefined;
    /** Redundant ingest endpoints the encoder pushes content to. */
    ingestEndpoints: {
      /** Ingest endpoint id (e.g. `"1"`, `"2"`). */
      id: string | undefined;
      /** Ingest URL the encoder pushes to. */
      url: string | undefined;
    }[];
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaPackage v2 channel — the entry point for live
 * content into MediaPackage. An encoder (such as AWS Elemental MediaLive)
 * pushes an HLS or CMAF stream to the channel's ingest endpoints; origin
 * endpoints then package and serve that content downstream.
 *
 * @resource
 * @section Creating a Channel
 * @example Basic Channel in a Group
 * ```typescript
 * import * as MediaPackageV2 from "alchemy/AWS/MediaPackageV2";
 *
 * const group = yield* MediaPackageV2.ChannelGroup("Live");
 * const channel = yield* MediaPackageV2.Channel("Feed", {
 *   channelGroupName: group.channelGroupName,
 * });
 * ```
 *
 * @example CMAF Ingest Channel
 * ```typescript
 * const channel = yield* MediaPackageV2.Channel("Feed", {
 *   channelGroupName: group.channelGroupName,
 *   inputType: "CMAF",
 *   description: "CMAF contribution feed",
 * });
 * ```
 *
 * @section Resource Policy
 * @example Allow a Principal to Push Content
 * ```typescript
 * const channel = yield* MediaPackageV2.Channel("Feed", {
 *   channelGroupName: group.channelGroupName,
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { AWS: "arn:aws:iam::111122223333:root" },
 *       Action: "mediapackagev2:PutObject",
 *       Resource: "arn:aws:mediapackagev2:us-east-1:111122223333:channelGroup/live/channel/feed",
 *     }],
 *   }),
 * });
 * ```
 *
 * @section Ingest Endpoints
 * @example Point the encoder at the ingest URLs
 * ```typescript
 * const channel = yield* MediaPackageV2.Channel("Feed", {
 *   channelGroupName: group.channelGroupName,
 * });
 * // Two redundant ingest endpoints for the encoder to push to.
 * const urls = channel.ingestEndpoints;
 * ```
 */
export const Channel = Resource<Channel>("AWS.MediaPackageV2.Channel");

export const ChannelProvider = () =>
  Provider.effect(
    Channel,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { channelName?: string },
      ) {
        return (
          props.channelName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const toAttrs = (channel: {
        Arn: string;
        ChannelName: string;
        ChannelGroupName: string;
        IngestEndpoints?: mediapackagev2.IngestEndpoint[];
        InputType?: mediapackagev2.InputType;
      }) => ({
        channelGroupName: channel.ChannelGroupName,
        channelName: channel.ChannelName,
        channelArn: channel.Arn,
        inputType: channel.InputType,
        ingestEndpoints: (channel.IngestEndpoints ?? []).map((endpoint) => ({
          id: endpoint.Id,
          url: endpoint.Url,
        })),
      });

      /** Get a channel by group + name; typed not-found → undefined. */
      const getChannel = Effect.fn(function* (
        channelGroupName: string,
        channelName: string,
      ) {
        return yield* mediapackagev2
          .getChannel({
            ChannelGroupName: channelGroupName,
            ChannelName: channelName,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["channelGroupName", "channelName", "channelArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          // Group, name, and input type are the channel's identity.
          if (olds.channelGroupName !== news.channelGroupName) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if ((olds.inputType ?? "HLS") !== (news.inputType ?? "HLS")) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const channelGroupName =
            output?.channelGroupName ?? olds?.channelGroupName;
          if (channelGroupName === undefined) return undefined;
          const channelName =
            output?.channelName ?? (yield* createName(id, olds ?? {}));
          const channel = yield* getChannel(channelGroupName, channelName);
          if (channel === undefined) return undefined;
          const attrs = toAttrs(channel);
          return (yield* hasAlchemyTags(id, toMpTagRecord(channel.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const channelGroupName = news.channelGroupName;
          const channelName =
            output?.channelName ?? (yield* createName(id, news));

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let channel = yield* getChannel(channelGroupName, channelName);

          // 2. Ensure — create if missing; a Conflict means a peer created it
          //    concurrently, so fall through to observing the winner.
          if (channel === undefined) {
            channel = yield* mediapackagev2
              .createChannel({
                ChannelGroupName: channelGroupName,
                ChannelName: channelName,
                InputType: news.inputType,
                Description: news.description,
                InputSwitchConfiguration: news.inputSwitchConfiguration,
                OutputHeaderConfiguration: news.outputHeaderConfiguration,
                Tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  mediapackagev2.getChannel({
                    ChannelGroupName: channelGroupName,
                    ChannelName: channelName,
                  }),
                ),
              );
          } else {
            // 3. Sync — apply the mutable fields only when the observed
            //    state has drifted from the desired state.
            const desired = {
              Description: news.description ?? "",
              InputSwitchConfiguration: news.inputSwitchConfiguration,
              OutputHeaderConfiguration: news.outputHeaderConfiguration,
            };
            const observed = {
              Description: channel.Description ?? "",
              InputSwitchConfiguration: channel.InputSwitchConfiguration,
              OutputHeaderConfiguration: channel.OutputHeaderConfiguration,
            };
            if (!matchesDesired(desired, observed)) {
              channel = yield* mediapackagev2.updateChannel({
                ChannelGroupName: channelGroupName,
                ChannelName: channelName,
                Description: news.description,
                InputSwitchConfiguration: news.inputSwitchConfiguration,
                OutputHeaderConfiguration: news.outputHeaderConfiguration,
              });
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMpTags(
            channel.Arn,
            toMpTagRecord(channel.Tags),
            desiredTags,
          );

          // 3c. Sync the resource policy — observe the live policy (absent
          //     policy is the typed not-found) and apply only the delta.
          const observedPolicy = yield* mediapackagev2
            .getChannelPolicy({
              ChannelGroupName: channelGroupName,
              ChannelName: channelName,
            })
            .pipe(
              Effect.map((response) => response.Policy as string | undefined),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (news.policy !== undefined) {
            if (!policiesEqual(observedPolicy, news.policy)) {
              yield* mediapackagev2.putChannelPolicy({
                ChannelGroupName: channelGroupName,
                ChannelName: channelName,
                Policy: news.policy,
              });
            }
          } else if (observedPolicy !== undefined) {
            yield* mediapackagev2.deleteChannelPolicy({
              ChannelGroupName: channelGroupName,
              ChannelName: channelName,
            });
          }

          yield* session.note(channelName);
          return toAttrs(channel);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Reap the channel's origin endpoints first (a normal stack destroy
          // already deleted them; an orphan sweep may not have), then delete
          // the channel. Every step is idempotent and the transient Conflict
          // while just-deleted endpoints are cleaned up is retried.
          yield* deleteChannelWithEndpoints(
            output.channelGroupName,
            output.channelName,
          );
        }),

        // Channels are keyed by their parent channel group, so enumerate
        // the groups first and fan out.
        list: () =>
          Effect.gen(function* () {
            const groups = yield* listAllChannelGroups();
            const items = yield* Effect.forEach(
              groups,
              (group) => listGroupChannels(group.ChannelGroupName),
              { concurrency: 5 },
            ).pipe(Effect.map((nested) => nested.flat()));
            // The list shape omits ingest endpoints, so hydrate each item
            // via get; a channel can vanish between enumeration and
            // hydration.
            const channels = yield* Effect.forEach(
              items,
              (item) =>
                getChannel(item.ChannelGroupName, item.ChannelName).pipe(
                  Effect.map((channel) =>
                    channel === undefined ? undefined : toAttrs(channel),
                  ),
                ),
              { concurrency: 5 },
            );
            return channels.filter(
              (channel): channel is Channel["Attributes"] =>
                channel !== undefined,
            );
          }),
      };
    }),
  );
