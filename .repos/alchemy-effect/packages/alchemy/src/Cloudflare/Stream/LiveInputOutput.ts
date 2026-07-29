import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Stream.LiveInputOutput" as const;
type TypeId = typeof TypeId;

export type LiveInputOutputProps = {
  /**
   * The unique identifier (`uid`) of the live input the output restreams
   * from. Usually a reference to a `LiveInput`'s `liveInputId`
   * attribute.
   *
   * Immutable — an output belongs to exactly one live input, so changing
   * it triggers a replacement.
   */
  liveInputId: string;
  /**
   * The URL the output restreams to, e.g.
   * `rtmps://a.rtmps.youtube.com/live2`.
   *
   * Immutable — Cloudflare's update endpoint only toggles `enabled`, so
   * changing the URL triggers a replacement.
   */
  url: string;
  /**
   * The streamKey used to authenticate against the output's target.
   *
   * Immutable — Cloudflare's update endpoint only toggles `enabled`, so
   * changing the streamKey triggers a replacement.
   */
  streamKey: string;
  /**
   * When enabled, live video streamed to the associated live input is
   * sent to the output URL. When disabled, live video is not sent to the
   * output URL, even while streaming to the associated live input.
   * Mutable.
   * @default true
   */
  enabled?: boolean;
};

export type LiveInputOutputAttributes = {
  /**
   * The unique identifier for the output (Cloudflare `uid`).
   */
  outputId: string;
  /**
   * The unique identifier of the live input the output belongs to.
   */
  liveInputId: string;
  /**
   * The Cloudflare account the output belongs to.
   */
  accountId: string;
  /**
   * The URL the output restreams to.
   */
  url: string;
  /**
   * The streamKey used to authenticate against the output's target.
   */
  streamKey: string;
  /**
   * Whether live video is sent to the output URL while streaming to the
   * associated live input.
   */
  enabled: boolean;
};

export type LiveInputOutput = Resource<
  TypeId,
  LiveInputOutputProps,
  LiveInputOutputAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Stream live input output — restreams (simulcasts) live
 * video received by a `LiveInput` to another RTMP(S) destination
 * such as YouTube Live or Twitch.
 *
 * The destination (`url` + `streamKey`) is immutable: Cloudflare's update
 * endpoint only toggles `enabled`, so changing the destination replaces
 * the output. Toggling `enabled` updates the output in place.
 *
 * Requires the Stream subscription to be enabled on the account.
 * @resource
 * @product Stream
 * @category Media
 * @section Creating an output
 * @example Restream a live input to YouTube
 * ```typescript
 * const input = yield* Cloudflare.Stream.LiveInput("Broadcast", {});
 *
 * const youtube = yield* Cloudflare.Stream.LiveInputOutput("YouTube", {
 *   liveInputId: input.liveInputId,
 *   url: "rtmps://a.rtmps.youtube.com/live2",
 *   streamKey: youtubeStreamKey,
 * });
 * ```
 *
 * @section Managing an output
 * @example Pause restreaming without deleting the output
 * ```typescript
 * const youtube = yield* Cloudflare.Stream.LiveInputOutput("YouTube", {
 *   liveInputId: input.liveInputId,
 *   url: "rtmps://a.rtmps.youtube.com/live2",
 *   streamKey: youtubeStreamKey,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/stream/stream-live/simulcasting/
 */
export const LiveInputOutput = Resource<LiveInputOutput>(TypeId);

/**
 * Returns true if the given value is a LiveInputOutput resource.
 */
export const isLiveInputOutput = (value: unknown): value is LiveInputOutput =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const LiveInputOutputProvider = () =>
  Provider.succeed(LiveInputOutput, {
    stables: ["outputId", "liveInputId", "accountId", "url", "streamKey"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // An output belongs to exactly one live input.
      const oldLiveInput = output?.liveInputId ?? olds?.liveInputId;
      if (
        typeof oldLiveInput === "string" &&
        typeof news.liveInputId === "string" &&
        oldLiveInput !== news.liveInputId
      ) {
        return { action: "replace" } as const;
      }
      // The destination is immutable — only `enabled` can be updated.
      const oldUrl = output?.url ?? olds?.url;
      if (oldUrl !== undefined && oldUrl !== news.url) {
        return { action: "replace" } as const;
      }
      const oldStreamKey = output?.streamKey ?? olds?.streamKey;
      if (oldStreamKey !== undefined && oldStreamKey !== news.streamKey) {
        return { action: "replace" } as const;
      }
      // `enabled` is mutable via PUT — default engine update logic.
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // Outputs have no deterministic name or tags, so a cold read (state
      // lost before the uid was persisted) cannot recover the resource —
      // rely on the cached uid.
      if (output?.outputId === undefined) return undefined;
      const observed = yield* findOutput(
        output.accountId,
        output.liveInputId,
        output.outputId,
      );
      return observed
        ? toAttributes(observed, output.accountId, output.liveInputId)
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const liveInputId = news.liveInputId as string;

      // Observe — the uid cached on `output` is a hint, not a guarantee:
      // a missing output (or live input) falls through to "missing" and
      // we recreate.
      const observed = output?.outputId
        ? yield* findOutput(
            output.accountId ?? accountId,
            liveInputId,
            output.outputId,
          )
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. uids are auto-assigned so there is no
        // AlreadyExists race to tolerate.
        const created = yield* stream.createLiveInputOutput({
          accountId,
          liveInputIdentifier: liveInputId,
          url: news.url,
          streamKey: news.streamKey,
          enabled: news.enabled,
        });
        return toAttributes(created, accountId, liveInputId);
      }

      // Sync — `enabled` is the only mutable aspect; diff observed cloud
      // state against desired and skip the PUT on a no-op.
      const observedAccount = output?.accountId ?? accountId;
      const desiredEnabled = news.enabled ?? true;
      if (desiredEnabled === (observed.enabled ?? true)) {
        return toAttributes(observed, observedAccount, liveInputId);
      }

      const updated = yield* stream.updateLiveInputOutput({
        accountId: observedAccount,
        liveInputIdentifier: liveInputId,
        outputIdentifier: observed.uid ?? output!.outputId,
        enabled: desiredEnabled,
      });
      return toAttributes(updated, observedAccount, liveInputId);
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Parent fan-out: outputs are sub-resources of a live input and
      // have no account-wide enumeration endpoint. Enumerate every live
      // input on the account, then list each input's outputs.
      // Cloudflare returns this list either wrapped (`{ liveInputs: [...] }`)
      // or as a bare `result` array depending on the account — handle both.
      const inputs = yield* stream.listLiveInputs({ accountId });
      const liveInputIds = (
        Array.isArray(inputs) ? inputs : (inputs.liveInputs ?? [])
      )
        .map((input) => input.uid)
        .filter((uid): uid is string => typeof uid === "string");

      const rows = yield* Effect.forEach(
        liveInputIds,
        (liveInputId) =>
          stream.listLiveInputOutputs
            .pages({
              accountId,
              liveInputIdentifier: liveInputId,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  page.result.map((observed) =>
                    toAttributes(observed, accountId, liveInputId),
                  ),
                ),
              ),
              // A live input deleted between enumeration and listing its
              // outputs counts as having no outputs.
              Effect.catchTag("LiveInputNotFound", () => Effect.succeed([])),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — an output (or its parent live input) already deleted
      // out-of-band surfaces as `OutputNotFound` (Cloudflare error code
      // 10003).
      yield* stream
        .deleteLiveInputOutput({
          accountId: output.accountId,
          liveInputIdentifier: output.liveInputId,
          outputIdentifier: output.outputId,
        })
        .pipe(Effect.catchTag("OutputNotFound", () => Effect.void));
    }),
  });

type ObservedOutput = {
  enabled?: boolean | null;
  streamKey?: string | null;
  uid?: string | null;
  url?: string | null;
};

/**
 * Find an output by uid under a live input, mapping "gone" — either the
 * output missing from the list or the parent live input deleted
 * (`LiveInputNotFound`, Cloudflare error code 10003) — to `undefined`.
 * There is no get-by-uid endpoint, so observation goes through the list.
 */
const findOutput = (accountId: string, liveInputId: string, outputId: string) =>
  stream
    .listLiveInputOutputs({ accountId, liveInputIdentifier: liveInputId })
    .pipe(
      Effect.map((page) =>
        page.result.find((candidate) => candidate.uid === outputId),
      ),
      Effect.catchTag("LiveInputNotFound", () => Effect.succeed(undefined)),
    );

const toAttributes = (
  output:
    | stream.CreateLiveInputOutputResponse
    | stream.UpdateLiveInputOutputResponse
    | ObservedOutput,
  accountId: string,
  liveInputId: string,
): LiveInputOutputAttributes => ({
  outputId: output.uid ?? "",
  liveInputId,
  accountId,
  url: output.url ?? "",
  streamKey: output.streamKey ?? "",
  enabled: output.enabled ?? true,
});
