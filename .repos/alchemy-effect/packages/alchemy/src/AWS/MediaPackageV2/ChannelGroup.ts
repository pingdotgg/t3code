import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteChannelWithEndpoints,
  listGroupChannels,
  retryWhileMpConflict,
  syncMpTags,
  toMpTagRecord,
} from "./internal.ts";

export interface ChannelGroupProps {
  /**
   * Name of the channel group. Must be unique within the account/region and
   * match `^[a-zA-Z0-9_-]+$`. If omitted, a unique name is generated.
   * Changing the name replaces the channel group.
   */
  channelGroupName?: string;
  /**
   * Optional description of the channel group (up to 1024 characters).
   */
  description?: string;
  /**
   * User-defined tags for the channel group. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface ChannelGroup extends Resource<
  "AWS.MediaPackageV2.ChannelGroup",
  ChannelGroupProps,
  {
    /** Name of the channel group. */
    channelGroupName: string;
    /** ARN of the channel group. */
    channelGroupArn: string;
    /** Shared egress domain that serves all origin endpoints in the group. */
    egressDomain: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaPackage v2 channel group — the top-level container
 * for channels and origin endpoints. All channels and origin endpoints in a
 * group share one egress domain, giving downstream players and CDNs
 * predictable URLs for stream delivery.
 *
 * @resource
 * @section Creating a Channel Group
 * @example Basic Channel Group
 * ```typescript
 * import * as MediaPackageV2 from "alchemy/AWS/MediaPackageV2";
 *
 * const group = yield* MediaPackageV2.ChannelGroup("Live");
 * ```
 *
 * @example Channel Group with Description and Tags
 * ```typescript
 * const group = yield* MediaPackageV2.ChannelGroup("Live", {
 *   description: "Live sports streams",
 *   tags: { team: "media" },
 * });
 * ```
 *
 * @section Egress Domain
 * @example Use the shared egress domain
 * ```typescript
 * const group = yield* MediaPackageV2.ChannelGroup("Live");
 * // e.g. abcde.egress.xyz.mediapackagev2.us-east-1.amazonaws.com
 * const domain = group.egressDomain;
 * ```
 */
export const ChannelGroup = Resource<ChannelGroup>(
  "AWS.MediaPackageV2.ChannelGroup",
);

export const ChannelGroupProvider = () =>
  Provider.effect(
    ChannelGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: ChannelGroupProps,
      ) {
        return (
          props.channelGroupName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const toAttrs = (group: {
        ChannelGroupName: string;
        Arn: string;
        EgressDomain: string;
      }) => ({
        channelGroupName: group.ChannelGroupName,
        channelGroupArn: group.Arn,
        egressDomain: group.EgressDomain,
      });

      /** Get a channel group by name; typed not-found → undefined. */
      const getGroup = Effect.fn(function* (channelGroupName: string) {
        return yield* mediapackagev2
          .getChannelGroup({ ChannelGroupName: channelGroupName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["channelGroupName", "channelGroupArn", "egressDomain"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // The name is the group's identity; a change means a new group.
          if (oldName !== newName) return { action: "replace" } as const;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.channelGroupName ?? (yield* createName(id, olds ?? {}));
          const group = yield* getGroup(name);
          if (group === undefined) return undefined;
          const attrs = toAttrs(group);
          return (yield* hasAlchemyTags(id, toMpTagRecord(group.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const name =
            output?.channelGroupName ?? (yield* createName(id, news));

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let group = yield* getGroup(name);

          // 2. Ensure — create if missing; a Conflict means a peer created it
          //    concurrently, so fall through to observing the winner.
          if (group === undefined) {
            group = yield* mediapackagev2
              .createChannelGroup({
                ChannelGroupName: name,
                Description: news.description,
                Tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  mediapackagev2.getChannelGroup({ ChannelGroupName: name }),
                ),
              );
          } else if ((news.description ?? "") !== (group.Description ?? "")) {
            // 3. Sync — the description is the only mutable field.
            group = yield* mediapackagev2.updateChannelGroup({
              ChannelGroupName: name,
              Description: news.description,
            });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMpTags(group.Arn, toMpTagRecord(group.Tags), desiredTags);

          yield* session.note(name);
          return toAttrs(group);
        }),

        delete: Effect.fn(function* ({ output }) {
          const channelGroupName = output.channelGroupName;
          // Reap child channels (and their origin endpoints) first. A normal
          // stack destroy deletes children before the group, so this observes
          // nothing — but an orphan sweep can target a group whose children
          // it never enumerated, and deleting the group would then Conflict
          // until the retry budget ran out and leak the group.
          const channels = yield* listGroupChannels(channelGroupName);
          yield* Effect.forEach(
            channels,
            (channel) =>
              deleteChannelWithEndpoints(channelGroupName, channel.ChannelName),
            { concurrency: 5, discard: true },
          );
          // MediaPackage v2 deletes are idempotent (deleting a missing group
          // succeeds), but the group transiently rejects deletion with a
          // Conflict while its just-deleted channels are cleaned up.
          yield* mediapackagev2
            .deleteChannelGroup({ ChannelGroupName: channelGroupName })
            .pipe(retryWhileMpConflict);
        }),

        list: () =>
          Effect.gen(function* () {
            const items = yield* mediapackagev2.listChannelGroups
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.Items ?? []),
                ),
              );
            // The list shape omits the egress domain, so hydrate each item
            // via get; a group can vanish between enumeration and hydration.
            const groups = yield* Effect.forEach(
              items,
              (item) =>
                mediapackagev2
                  .getChannelGroup({ ChannelGroupName: item.ChannelGroupName })
                  .pipe(
                    Effect.map(toAttrs),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              { concurrency: 5 },
            );
            return groups.filter(
              (g): g is ChannelGroup["Attributes"] => g !== undefined,
            );
          }),
      };
    }),
  );
