import * as ivs from "@distilled.cloud/aws/ivs";
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
import { retryWhileThrottled, syncIvsTags, toTagRecord } from "./internal.ts";

export interface PlaybackKeyPairProps {
  /**
   * The PEM-encoded ECDSA P-384 public key to import. The corresponding
   * private key is held by the caller and used to sign viewer playback
   * authorization tokens for private channels. Changing the key material
   * replaces the key pair (the fingerprint and ARN change).
   */
  publicKeyMaterial: string;
  /**
   * Name of the playback key pair. If omitted, a deterministic physical
   * name is generated. Key pairs have no update operation, so changing
   * the name replaces the key pair.
   */
  playbackKeyPairName?: string;
  /**
   * Tags to apply to the key pair. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface PlaybackKeyPair extends Resource<
  "AWS.IVS.PlaybackKeyPair",
  PlaybackKeyPairProps,
  {
    /**
     * The key pair's physical name.
     */
    playbackKeyPairName: string;
    /**
     * ARN of the imported playback key pair.
     */
    playbackKeyPairArn: string;
    /**
     * Fingerprint of the imported public key.
     */
    fingerprint: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon IVS playback key pair for private channels.
 *
 * Import the public half of an ECDSA P-384 key pair; sign viewer playback
 * authorization tokens with the private half. Channels created with
 * `authorized: true` require viewers to present a token signed by an
 * imported key pair.
 * @resource
 * @section Importing a Key Pair
 * @example Private Channel Playback Authorization
 * ```typescript
 * import * as IVS from "alchemy/AWS/IVS";
 *
 * const keyPair = yield* IVS.PlaybackKeyPair("ViewerAuth", {
 *   publicKeyMaterial: PUBLIC_KEY_PEM, // ECDSA P-384 public key
 * });
 * const channel = yield* IVS.Channel("PrivateChannel", {
 *   authorized: true,
 * });
 * ```
 */
export const PlaybackKeyPair = Resource<PlaybackKeyPair>(
  "AWS.IVS.PlaybackKeyPair",
);

/**
 * Raised when the IVS API returns a playback key pair missing its ARN or
 * name.
 */
export class IvsPlaybackKeyPairIncomplete extends Data.TaggedError(
  "IvsPlaybackKeyPairIncomplete",
)<{ message: string }> {}

/**
 * DeletePlaybackKeyPair intermittently returns InternalServerException even
 * though a subsequent attempt succeeds. Retry only that typed transient error
 * on a bounded schedule; other delete errors still fail immediately.
 */
const retryDeleteInternalServer = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (error) => error._tag === "InternalServerException",
    schedule: Schedule.max([
      Schedule.exponential("500 millis"),
      Schedule.recurs(6),
    ]),
  });

export const PlaybackKeyPairProvider = () =>
  Provider.effect(
    PlaybackKeyPair,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { playbackKeyPairName?: string | undefined },
      ) =>
        props.playbackKeyPairName
          ? Effect.succeed(props.playbackKeyPairName)
          : createPhysicalName({ id, maxLength: 128 });

      const toAttrs = Effect.fn(function* (keyPair: ivs.PlaybackKeyPair) {
        if (!keyPair.arn || !keyPair.name) {
          return yield* Effect.fail(
            new IvsPlaybackKeyPairIncomplete({
              message: "IVS playback key pair is missing its ARN or name",
            }),
          );
        }
        return {
          playbackKeyPairName: keyPair.name,
          playbackKeyPairArn: keyPair.arn,
          fingerprint: keyPair.fingerprint,
        };
      });

      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* ivs.getPlaybackKeyPair({ arn }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
        return response?.keyPair;
      });

      /**
       * ListPlaybackKeyPairs has no name filter — enumerate and match
       * exactly (key pair names are unique per account/region).
       */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* ivs.listPlaybackKeyPairs.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.keyPairs),
          ),
          retryWhileThrottled,
        );
        const match = summaries.find((s) => s.name === name && s.arn);
        return match?.arn ? yield* getByArn(match.arn) : undefined;
      });

      return {
        stables: ["playbackKeyPairName", "playbackKeyPairArn", "fingerprint"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const keyPair = output?.playbackKeyPairArn
            ? yield* getByArn(output.playbackKeyPairArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (keyPair === undefined) return undefined;
          const attrs = yield* toAttrs(keyPair);
          return (yield* hasAlchemyTags(id, toTagRecord(keyPair.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          // There is no UpdatePlaybackKeyPair — both the key material and
          // the name are immutable. Key pair names are unique, so replacing
          // the material under the SAME name must delete the old key pair
          // first (create-before-delete would find the old one by name and
          // wrongly adopt it).
          if (olds.publicKeyMaterial !== news.publicKeyMaterial) {
            const sameName =
              (yield* toName(id, olds)) === (yield* toName(id, news));
            return { action: "replace", deleteFirst: sameName } as const;
          }
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = output?.playbackKeyPairArn
            ? yield* getByArn(output.playbackKeyPairArn)
            : yield* findByName(name);

          // 2. Ensure — import if missing. A ConflictException means the
          // name already exists (a race with a peer reconciler or a
          // state-persistence failure): adopt it by name.
          if (observed === undefined) {
            observed = yield* ivs
              .importPlaybackKeyPair({
                publicKeyMaterial: news.publicKeyMaterial,
                name,
                tags: desiredTags,
              })
              .pipe(
                retryWhileThrottled,
                Effect.map((r) => r.keyPair),
                Effect.catchTag("ConflictException", () => findByName(name)),
              );
          }
          const arn = observed?.arn;
          if (observed === undefined || arn === undefined) {
            return yield* Effect.fail(
              new IvsPlaybackKeyPairIncomplete({
                message: `IVS playback key pair '${name}' could not be imported or found`,
              }),
            );
          }

          // 3. Sync tags — the only mutable aspect.
          yield* syncIvsTags(arn, desiredTags);

          // 4. Return fresh attributes.
          const final = yield* getByArn(arn);
          if (final === undefined) {
            return yield* Effect.fail(
              new IvsPlaybackKeyPairIncomplete({
                message: `IVS playback key pair '${arn}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(arn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* ivs
            .deletePlaybackKeyPair({ arn: output.playbackKeyPairArn })
            .pipe(
              retryWhileThrottled,
              retryDeleteInternalServer,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          ivs.listPlaybackKeyPairs.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.keyPairs),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  summary.arn === undefined
                    ? Effect.succeed(undefined)
                    : getByArn(summary.arn).pipe(
                        Effect.flatMap((keyPair) =>
                          keyPair === undefined
                            ? Effect.succeed(undefined)
                            : toAttrs(keyPair),
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
