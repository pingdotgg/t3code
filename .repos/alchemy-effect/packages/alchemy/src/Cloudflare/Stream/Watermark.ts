import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Stream.Watermark" as const;
type TypeId = typeof TypeId;

/**
 * Location of the watermark image on the video.
 */
export type WatermarkPosition =
  | "upperRight"
  | "upperLeft"
  | "lowerLeft"
  | "lowerRight"
  | "center";

export type WatermarkProps = {
  /**
   * A short description of the watermark profile. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Watermark
   * profiles have no update endpoint — changing the name triggers a
   * replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * URL of the watermark image (a PNG up to 2 MiB) for Cloudflare to
   * download. Changing the URL triggers a replacement.
   */
  url: string;
  /**
   * The translucency of the image. `0.0` is completely transparent and
   * `1.0` is completely opaque. Changing the opacity triggers a
   * replacement.
   * @default 1.0
   */
  opacity?: number;
  /**
   * The whitespace between the adjacent edges (determined by position)
   * of the video and the image. `0.0` is no padding, `1.0` is a fully
   * padded video width or length. Changing the padding triggers a
   * replacement.
   * @default 0.05
   */
  padding?: number;
  /**
   * The location of the image. Note that `center` ignores the `padding`
   * parameter. Changing the position triggers a replacement.
   * @default "upperRight"
   */
  position?: WatermarkPosition;
  /**
   * The size of the image relative to the overall size of the video.
   * `0.0` means no scaling, `1.0` fills the entire video. Changing the
   * scale triggers a replacement.
   * @default 0.15
   */
  scale?: number;
};

export type WatermarkAttributes = {
  /**
   * The unique identifier for the watermark profile (Cloudflare `uid`).
   */
  watermarkId: string;
  /**
   * The Cloudflare account the watermark profile belongs to.
   */
  accountId: string;
  /**
   * A short description of the watermark profile.
   */
  name: string;
  /**
   * The date and time the watermark profile was created.
   */
  created: string | undefined;
  /**
   * The source URL the watermark image was downloaded from.
   */
  downloadedFrom: string | undefined;
  /**
   * The translucency of the image.
   */
  opacity: number;
  /**
   * The whitespace between the video edges and the image.
   */
  padding: number;
  /**
   * The location of the image.
   */
  position: WatermarkPosition;
  /**
   * The size of the image relative to the overall size of the video.
   */
  scale: number;
  /**
   * The size of the image in bytes.
   */
  size: number | undefined;
  /**
   * The height of the image in pixels.
   */
  height: number | undefined;
  /**
   * The width of the image in pixels.
   */
  width: number | undefined;
};

export type Watermark = Resource<
  TypeId,
  WatermarkProps,
  WatermarkAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Stream watermark profile — a PNG image stamped onto
 * videos at upload time.
 *
 * Watermark profiles are create-only: Cloudflare exposes no update
 * endpoint, so **every** prop change triggers a replacement (a new
 * profile is created and the old one deleted). The image is downloaded
 * by Cloudflare from the given URL at creation time.
 *
 * Requires the Stream subscription to be enabled on the account.
 * @resource
 * @product Stream
 * @category Media
 * @section Creating a watermark
 * @example Default watermark from an image URL
 * ```typescript
 * const watermark = yield* Cloudflare.Stream.Watermark("Logo", {
 *   url: "https://example.com/logo.png",
 * });
 * ```
 *
 * @example Centered semi-transparent watermark
 * ```typescript
 * const watermark = yield* Cloudflare.Stream.Watermark("Logo", {
 *   url: "https://example.com/logo.png",
 *   position: "center",
 *   opacity: 0.5,
 *   scale: 0.3,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/stream/edit-videos/applying-watermarks/
 */
export const Watermark = Resource<Watermark>(TypeId);

/**
 * Returns true if the given value is a Watermark resource.
 */
export const isWatermark = (value: unknown): value is Watermark =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WatermarkProvider = () =>
  Provider.succeed(Watermark, {
    stables: [
      "watermarkId",
      "accountId",
      "created",
      "downloadedFrom",
      "size",
      "height",
      "width",
    ],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      if (olds === undefined) return undefined;
      // `news` may still contain unresolved Outputs at plan time — let
      // the engine apply the default update logic in that case.
      if (!isResolved(news)) return undefined;
      // No update endpoint — any prop change is a replacement. Compare
      // against the observed output where the API echoes the value, and
      // against olds for the create-only `url`.
      const oldName =
        output?.name ?? olds.name ?? (yield* watermarkName(id, olds.name));
      const newName = yield* watermarkName(id, news.name);
      if (
        newName !== oldName ||
        news.url !== olds.url ||
        (news.opacity ?? 1.0) !== (output?.opacity ?? olds.opacity ?? 1.0) ||
        (news.padding ?? 0.05) !== (output?.padding ?? olds.padding ?? 0.05) ||
        (news.position ?? "upperRight") !==
          (output?.position ?? olds.position ?? "upperRight") ||
        (news.scale ?? 0.15) !== (output?.scale ?? olds.scale ?? 0.15)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.watermarkId) {
        const observed = yield* getWatermark(acct, output.watermarkId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the
      // deterministic physical name. Names are not unique on
      // Cloudflare's side; an exact match on our generated/explicit
      // name is the best identity we have.
      const name = yield* watermarkName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* watermarkName(id, news.name);

      // Observe — the uid cached on `output` is a hint, not a
      // guarantee: a not-found falls through to "missing" and we
      // recreate.
      const observed = output?.watermarkId
        ? yield* getWatermark(output.accountId ?? accountId, output.watermarkId)
        : undefined;

      if (observed) {
        // Create-only resource — prop drift is handled as a replacement
        // by `diff`; nothing to sync here.
        return toAttributes(observed, output?.accountId ?? accountId);
      }

      // Ensure — create with the full desired body. uids are
      // auto-assigned so there is no AlreadyExists race to tolerate.
      const created = yield* stream.createWatermark({
        accountId,
        name,
        url: news.url,
        opacity: news.opacity,
        padding: news.padding,
        position: news.position,
        scale: news.scale,
      });
      return toAttributes(created, accountId);
    }),

    list: Effect.fn(function* () {
      // Account-scoped collection — watermark profiles are enumerated
      // per account. `listWatermarks` is paginated (items: "result");
      // collect every page and hydrate into the `read` Attributes shape.
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* stream.listWatermarks.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((w) => toAttributes(w, accountId)),
          ),
        ),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — a watermark already deleted out-of-band surfaces
      // as `WatermarkNotFound` (Cloudflare error code 10003).
      yield* stream
        .deleteWatermark({
          accountId: output.accountId,
          identifier: output.watermarkId,
        })
        .pipe(Effect.catchTag("WatermarkNotFound", () => Effect.void));
    }),
  });

/**
 * Read a watermark by uid, mapping "gone" (`WatermarkNotFound`,
 * Cloudflare error code 10003) to `undefined`.
 */
const getWatermark = (accountId: string, watermarkId: string) =>
  stream
    .getWatermark({ accountId, identifier: watermarkId })
    .pipe(
      Effect.catchTag("WatermarkNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a watermark by exact name. Names are not unique — if several
 * watermarks carry the same name, pick the oldest for determinism.
 */
const findByName = (accountId: string, name: string) =>
  stream.listWatermarks({ accountId }).pipe(
    Effect.map((list) =>
      [...list.result]
        .filter((w) => w.name === name)
        .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""))
        .at(0),
    ),
  );

const watermarkName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  watermark:
    | stream.GetWatermarkResponse
    | stream.CreateWatermarkResponse
    | stream.ListWatermarksResponse["result"][number],
  accountId: string,
): WatermarkAttributes => ({
  watermarkId: watermark.uid ?? "",
  accountId,
  name: watermark.name ?? "",
  created: watermark.created ?? undefined,
  downloadedFrom: watermark.downloadedFrom ?? undefined,
  opacity: watermark.opacity ?? 1.0,
  padding: watermark.padding ?? 0.05,
  position: (watermark.position ?? "upperRight") as WatermarkPosition,
  scale: watermark.scale ?? 0.15,
  size: watermark.size ?? undefined,
  height: watermark.height ?? undefined,
  width: watermark.width ?? undefined,
});
