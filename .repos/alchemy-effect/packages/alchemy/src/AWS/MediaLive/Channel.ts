import * as medialive from "@distilled.cloud/aws/medialive";
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
import {
  MediaLiveResourcePending,
  ensureIdentified,
  ensurePresent,
  retryWhileConflict,
  retryWhilePending,
  syncMlTags,
  toTagRecord,
} from "./internal.ts";

/**
 * The observed shape shared by `DescribeChannelResponse` and the `Channel`
 * struct returned by create/update (and `ChannelSummary` from list).
 */
type ObservedChannel = Pick<
  medialive.Channel,
  | "Arn"
  | "Id"
  | "Name"
  | "State"
  | "ChannelClass"
  | "EgressEndpoints"
  | "LogLevel"
  | "RoleArn"
  | "Tags"
>;

type IdentifiedChannel = ObservedChannel & { Id: string; Arn: string };

// Explicitly-typed pipeable retry helper (see internal.ts for why inline
// Effect.retry is forbidden in provider ops). A freshly-created IAM role is
// not immediately visible to MediaLive — createChannel rejects it with a
// message-discriminated UnprocessableEntityException naming the trust
// relationship (patched in distilled to the typed `MediaLiveRoleNotYetTrusted`
// tag) until IAM propagation settles.
const retryWhileRolePropagating = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "MediaLiveRoleNotYetTrusted",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Raised when a MediaLive channel lands in `CREATE_FAILED` or `UPDATE_FAILED`
 * instead of settling into `IDLE`.
 */
export class MediaLiveChannelFailed extends Data.TaggedError(
  "MediaLiveChannelFailed",
)<{ message: string }> {}

export interface ChannelProps {
  /**
   * Name of the channel. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Names are mutable — changing the name
   * updates the channel in place.
   */
  name?: string;
  /**
   * The class of the channel. `STANDARD` runs two redundant encoder
   * pipelines; `SINGLE_PIPELINE` runs one. Changing the class replaces the
   * channel.
   * @default "STANDARD"
   */
  channelClass?: medialive.ChannelClass;
  /**
   * ARN of the IAM role MediaLive assumes to read inputs and write outputs
   * (trusts `medialive.amazonaws.com`).
   */
  roleArn?: string;
  /**
   * The inputs attached to this channel.
   */
  inputAttachments?: medialive.InputAttachment[];
  /**
   * The encoder settings — audio/video descriptions, output groups, and
   * timecode configuration.
   */
  encoderSettings?: medialive.EncoderSettings;
  /**
   * Destinations referenced by the output groups in `encoderSettings`.
   */
  destinations?: medialive.OutputDestination[];
  /**
   * Specification of the input codec/resolution/bitrate tier (drives
   * per-hour pricing).
   */
  inputSpecification?: medialive.InputSpecification;
  /**
   * Specification of CDI inputs for this channel.
   */
  cdiInputSpecification?: medialive.CdiInputSpecification;
  /**
   * The CloudWatch log level for the channel.
   * @default "DISABLED"
   */
  logLevel?: medialive.LogLevel;
  /**
   * Maintenance window settings (day + start hour).
   */
  maintenance?: medialive.MaintenanceCreateSettings;
  /**
   * VPC output settings. Changing the VPC settings replaces the channel.
   */
  vpc?: medialive.VpcOutputSettings;
  /**
   * User-defined tags for the channel.
   */
  tags?: Record<string, string>;
}

export interface Channel extends Resource<
  "AWS.MediaLive.Channel",
  ChannelProps,
  {
    /** Server-assigned unique id of the channel. */
    channelId: string;
    /** ARN of the channel. */
    channelArn: string;
    /** Name of the channel. */
    channelName: string | undefined;
    /** Current lifecycle state (e.g. `IDLE`, `RUNNING`). */
    state: medialive.ChannelState | undefined;
    /** Pipeline class (`STANDARD` or `SINGLE_PIPELINE`). */
    channelClass: medialive.ChannelClass | undefined;
    /** Egress endpoints the channel writes output through. */
    egressEndpoints: medialive.ChannelEgressEndpoint[];
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaLive channel — the live encoder that reads from
 * attached inputs, transcodes per its encoder settings, and writes to output
 * destinations (HLS, RTMP, MediaPackage, ...).
 *
 * Channels bill per running hour; Alchemy provisions channels in the `IDLE`
 * state and never starts them — start/stop is a runtime operation.
 *
 * @resource
 * @section Creating a Channel
 * @example Single-pipeline HLS channel
 * ```typescript
 * const channel = yield* MediaLive.Channel("Live", {
 *   channelClass: "SINGLE_PIPELINE",
 *   roleArn: role.roleArn,
 *   inputAttachments: [
 *     { InputId: input.inputId, InputAttachmentName: "primary" },
 *   ],
 *   inputSpecification: {
 *     Codec: "AVC",
 *     Resolution: "SD",
 *     MaximumBitrate: "MAX_10_MBPS",
 *   },
 *   destinations,
 *   encoderSettings,
 * });
 * ```
 *
 * @example IAM role for MediaLive
 * ```typescript
 * const role = yield* IAM.Role("MediaLiveRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "medialive.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const Channel = Resource<Channel>("AWS.MediaLive.Channel");

export const ChannelProvider = () =>
  Provider.effect(
    Channel,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
      });

      const toAttrs = (channel: IdentifiedChannel) => ({
        channelId: channel.Id,
        channelArn: channel.Arn,
        channelName: channel.Name,
        state: channel.State,
        channelClass: channel.ChannelClass,
        egressEndpoints: [...(channel.EgressEndpoints ?? [])],
      });

      const isGone = (state: medialive.ChannelState | undefined) =>
        state === "DELETED" || state === "DELETING";

      /** Describe by id; typed not-found (or tombstone state) → undefined. */
      const getChannel = Effect.fn(function* (channelId: string) {
        const channel = yield* medialive
          .describeChannel({ ChannelId: channelId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (channel === undefined || isGone(channel.State)) return undefined;
        return yield* ensureIdentified(channel, "DescribeChannel Id/Arn");
      });

      /**
       * Channels have server-assigned ids, so a read without cached output
       * searches the account list by the deterministic physical name.
       */
      const findByName = Effect.fn(function* (name: string) {
        const channels = yield* medialive.listChannels.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        const match = channels.find(
          (channel) => channel.Name === name && !isGone(channel.State),
        );
        if (match === undefined) return undefined;
        return yield* ensureIdentified(match, "ListChannels item Id/Arn");
      });

      /**
       * Wait (bounded, ~90s) for a channel to settle out of the transient
       * `CREATING`/`UPDATING` states; fail typed on `*_FAILED`.
       */
      const awaitSettled = Effect.fn(function* (channelId: string) {
        return yield* retryWhilePending(
          Effect.gen(function* () {
            const channel = yield* medialive.describeChannel({
              ChannelId: channelId,
            });
            if (
              channel.State === "CREATE_FAILED" ||
              channel.State === "UPDATE_FAILED"
            ) {
              return yield* Effect.fail(
                new MediaLiveChannelFailed({
                  message: `channel ${channelId} is in state ${channel.State}`,
                }),
              );
            }
            if (channel.State === "CREATING" || channel.State === "UPDATING") {
              return yield* Effect.fail(
                new MediaLiveResourcePending({
                  message: `channel ${channelId} is still ${channel.State}`,
                }),
              );
            }
            return yield* ensureIdentified(channel, "DescribeChannel Id/Arn");
          }),
        );
      });

      return Channel.Provider.of({
        stables: ["channelId", "channelArn"],

        list: () =>
          medialive.listChannels.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .filter(
                  (
                    channel,
                  ): channel is medialive.ChannelSummary & IdentifiedChannel =>
                    channel.Id !== undefined &&
                    channel.Arn !== undefined &&
                    !isGone(channel.State),
                )
                .map(toAttrs),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const channel =
            output?.channelId !== undefined
              ? yield* getChannel(output.channelId)
              : yield* findByName(yield* createName(id, olds ?? {}));
          if (channel === undefined) return undefined;
          const attrs = toAttrs(channel);
          return (yield* hasAlchemyTags(id, toTagRecord(channel.Tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // The channel class and VPC placement are fixed at creation.
          if (
            (olds.channelClass ?? "STANDARD") !==
            (news.channelClass ?? "STANDARD")
          ) {
            return { action: "replace" } as const;
          }
          if (JSON.stringify(olds.vpc) !== JSON.stringify(news.vpc)) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const name = yield* createName(id, news);

          // 1. Observe — cloud state is authoritative; output is an id cache.
          // MediaLive channel names are not unique, so a name match is only
          // trusted when its immutable class agrees with the desired state —
          // during a replacement the same-named survivor is the doomed old
          // instance, not this one.
          let channel: IdentifiedChannel | undefined;
          if (output?.channelId !== undefined) {
            channel = yield* getChannel(output.channelId);
          } else {
            const found = yield* findByName(name);
            channel =
              found !== undefined &&
              (found.ChannelClass ?? "STANDARD") ===
                (news.channelClass ?? "STANDARD")
                ? found
                : undefined;
          }

          // 2. Ensure — create if missing, then wait for CREATING to settle.
          if (channel === undefined) {
            const created = yield* medialive
              .createChannel({
                Name: name,
                ChannelClass: news.channelClass,
                RoleArn: news.roleArn,
                InputAttachments: news.inputAttachments,
                EncoderSettings: news.encoderSettings,
                Destinations: news.destinations,
                InputSpecification: news.inputSpecification,
                CdiInputSpecification: news.cdiInputSpecification,
                LogLevel: news.logLevel,
                Maintenance: news.maintenance,
                Vpc: news.vpc,
                Tags: desiredTags,
              })
              .pipe(retryWhileRolePropagating);
            const fresh = yield* ensureIdentified(
              created.Channel,
              "CreateChannel Channel Id/Arn",
            );
            channel = yield* awaitSettled(fresh.Id);
          } else {
            // 3. Sync — cheap scalars are diffed against OBSERVED state; the
            // deep encoder/attachment documents are diffed against `olds` as
            // a no-op hint (Describe echoes them back default-expanded, so an
            // observed-vs-desired deep compare would always report drift).
            const nameDrift = channel.Name !== name;
            const logDrift =
              news.logLevel !== undefined && channel.LogLevel !== news.logLevel;
            const roleDrift =
              news.roleArn !== undefined && channel.RoleArn !== news.roleArn;
            const deepDrift =
              olds === undefined
                ? true
                : JSON.stringify({
                    a: olds.inputAttachments,
                    e: olds.encoderSettings,
                    d: olds.destinations,
                    i: olds.inputSpecification,
                    c: olds.cdiInputSpecification,
                  }) !==
                  JSON.stringify({
                    a: news.inputAttachments,
                    e: news.encoderSettings,
                    d: news.destinations,
                    i: news.inputSpecification,
                    c: news.cdiInputSpecification,
                  });
            if (nameDrift || logDrift || roleDrift || deepDrift) {
              yield* medialive
                .updateChannel({
                  ChannelId: channel.Id,
                  Name: name,
                  RoleArn: news.roleArn,
                  InputAttachments: news.inputAttachments,
                  EncoderSettings: news.encoderSettings,
                  Destinations: news.destinations,
                  InputSpecification: news.inputSpecification,
                  CdiInputSpecification: news.cdiInputSpecification,
                  LogLevel: news.logLevel,
                  Maintenance: news.maintenance
                    ? {
                        MaintenanceDay: news.maintenance.MaintenanceDay,
                        MaintenanceStartTime:
                          news.maintenance.MaintenanceStartTime,
                      }
                    : undefined,
                })
                .pipe(retryWhileConflict);
              channel = yield* awaitSettled(channel.Id);
            }
          }

          // Both the ensure and sync branches leave `channel` assigned from a
          // typed describe; guard with a typed failure so TS sees it defined.
          const settled = yield* ensurePresent(
            channel,
            "reconciled channel state",
          );

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMlTags(settled.Arn, desiredTags);

          yield* session.note(settled.Id);
          return toAttrs(settled);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* medialive.deleteChannel({ ChannelId: output.channelId }).pipe(
            retryWhileConflict,
            Effect.catchTag("NotFoundException", () => Effect.void),
            Effect.asVoid,
          );
          // Deletion is async (DELETING → DELETED). Wait (bounded) so that
          // dependent Inputs/InputSecurityGroups can delete without long
          // conflict-retry loops; if the channel is still draining after the
          // window, deletion is initiated and irreversible — let downstream
          // retries absorb the tail.
          yield* medialive
            .describeChannel({ ChannelId: output.channelId })
            .pipe(
              Effect.flatMap((channel) =>
                channel.State === "DELETED"
                  ? Effect.void
                  : Effect.fail(
                      new MediaLiveResourcePending({
                        message: `channel ${output.channelId} is still ${channel.State}`,
                      }),
                    ),
              ),
              retryWhilePending,
              Effect.catchTag("NotFoundException", () => Effect.void),
              Effect.catchTag("MediaLiveResourcePending", () => Effect.void),
            );
        }),
      });
    }),
  );
