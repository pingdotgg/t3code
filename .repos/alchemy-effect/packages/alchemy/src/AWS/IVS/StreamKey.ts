import * as ivs from "@distilled.cloud/aws/ivs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toRedactedString } from "../IAM/common.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileThrottled, syncIvsTags, toTagRecord } from "./internal.ts";

export interface StreamKeyProps {
  /**
   * ARN of the channel the stream key authorizes broadcasts to.
   * Changing the channel replaces the stream key.
   */
  channelArn: string;
  /**
   * Tags to apply to the stream key. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface StreamKey extends Resource<
  "AWS.IVS.StreamKey",
  StreamKeyProps,
  {
    /**
     * ARN of the stream key.
     */
    streamKeyArn: string;
    /**
     * ARN of the channel the stream key authorizes broadcasts to.
     */
    channelArn: string;
    /**
     * The secret stream key value used by broadcast software to
     * authenticate against the channel's ingest endpoint.
     */
    value: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon IVS stream key — the secret credential broadcast software
 * uses to authenticate against a channel's ingest endpoint.
 *
 * IVS allows at most one stream key per channel, and `CreateChannel`
 * provisions one automatically. This resource therefore *manages the
 * channel's stream key*: if the channel already has its auto-created key,
 * the resource takes ownership of it (tagging it with Alchemy's internal
 * tags) instead of failing the per-channel quota.
 * @resource
 * @section Creating Stream Keys
 * @example Stream Key for a Channel
 * ```typescript
 * import * as IVS from "alchemy/AWS/IVS";
 *
 * const channel = yield* IVS.Channel("LiveChannel");
 * const streamKey = yield* IVS.StreamKey("LiveKey", {
 *   channelArn: channel.channelArn,
 * });
 * ```
 */
export const StreamKey = Resource<StreamKey>("AWS.IVS.StreamKey");

/**
 * Raised when the IVS API returns a stream key missing its ARN or channel
 * ARN.
 */
export class IvsStreamKeyIncomplete extends Data.TaggedError(
  "IvsStreamKeyIncomplete",
)<{ message: string }> {}

export const StreamKeyProvider = () =>
  Provider.effect(
    StreamKey,
    Effect.gen(function* () {
      const toAttrs = Effect.fn(function* (streamKey: ivs.StreamKey) {
        if (!streamKey.arn || !streamKey.channelArn) {
          return yield* Effect.fail(
            new IvsStreamKeyIncomplete({
              message: "IVS stream key is missing its ARN or channel ARN",
            }),
          );
        }
        return {
          streamKeyArn: streamKey.arn,
          channelArn: streamKey.channelArn,
          value: toRedactedString(streamKey.value),
        };
      });

      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* ivs.getStreamKey({ arn }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
        return response?.streamKey;
      });

      /**
       * A channel has at most one stream key, so "the channel's stream
       * key" is a well-defined lookup. Tolerates a deleted channel (the
       * key is gone with it).
       */
      const findByChannel = Effect.fn(function* (channelArn: string) {
        const page = yield* ivs.listStreamKeys({ channelArn }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
        const arn = page?.streamKeys.find((s) => s.arn !== undefined)?.arn;
        return arn === undefined ? undefined : yield* getByArn(arn);
      });

      return {
        stables: ["streamKeyArn", "channelArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const streamKey = output?.streamKeyArn
            ? yield* getByArn(output.streamKeyArn)
            : olds?.channelArn
              ? yield* findByChannel(olds.channelArn)
              : undefined;
          if (streamKey === undefined) return undefined;
          const attrs = yield* toAttrs(streamKey);
          return (yield* hasAlchemyTags(id, toTagRecord(streamKey.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // A stream key is bound to its channel at create time — moving
          // it to another channel requires a replacement.
          if (olds.channelArn !== news.channelArn) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — prefer the cached ARN; fall back to the channel's
          // (at most one) existing key.
          let observed = output?.streamKeyArn
            ? yield* getByArn(output.streamKeyArn)
            : yield* findByChannel(news.channelArn);
          // A cached ARN can belong to a previous channel after a failed
          // replacement — only trust keys on the desired channel.
          if (
            observed !== undefined &&
            observed.channelArn !== news.channelArn
          ) {
            observed = undefined;
          }

          // 2. Ensure — create if missing. The per-channel quota is 1 and
          // CreateChannel auto-provisions a key, so a quota rejection means
          // the channel already has its key: adopt it (tags are converged
          // below).
          if (observed === undefined) {
            observed = yield* ivs
              .createStreamKey({
                channelArn: news.channelArn,
                tags: desiredTags,
              })
              .pipe(
                retryWhileThrottled,
                Effect.map((r) => r.streamKey),
                Effect.catchTag("ServiceQuotaExceededException", () =>
                  findByChannel(news.channelArn),
                ),
              );
          }
          const arn = observed?.arn;
          if (observed === undefined || arn === undefined) {
            return yield* Effect.fail(
              new IvsStreamKeyIncomplete({
                message: `IVS channel '${news.channelArn}' has no stream key and one could not be created`,
              }),
            );
          }

          // 3. Sync tags — the only mutable aspect. Diff against OBSERVED
          // cloud tags so adopting the auto-created key converges.
          yield* syncIvsTags(arn, desiredTags);

          // 4. Return fresh attributes (GetStreamKey carries the secret
          // value; the ListStreamKeys summary does not).
          const final = yield* getByArn(arn);
          if (final === undefined) {
            return yield* Effect.fail(
              new IvsStreamKeyIncomplete({
                message: `IVS stream key '${arn}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(arn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* ivs.deleteStreamKey({ arn: output.streamKeyArn }).pipe(
            retryWhileThrottled,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),

        // Stream keys are sub-resources keyed by their parent channel —
        // there is no account-level enumeration to reconcile against.
        list: () => Effect.succeed([]),
      };
    }),
  );
