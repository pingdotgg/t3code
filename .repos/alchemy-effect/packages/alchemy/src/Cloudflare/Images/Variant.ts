import * as images from "@distilled.cloud/cloudflare/images";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Images.Variant" as const;
type TypeId = typeof TypeId;

/**
 * How an image is resized to fit a variant's `width`x`height` box.
 */
export type VariantFit = "scale-down" | "contain" | "cover" | "crop" | "pad";

/**
 * What happens to the image's EXIF metadata when the variant is served.
 */
export type VariantMetadata = "keep" | "copyright" | "none";

export interface VariantProps {
  /**
   * Account the variant is created in. Defaults to the ambient Cloudflare
   * account. Changing it triggers a replacement.
   */
  accountId?: string;
  /**
   * Variant name — the URL segment used to request the variant (e.g.
   * `https://imagedelivery.net/<hash>/<image>/<name>`). Alphanumeric only;
   * Cloudflare rejects hyphens and underscores.
   *
   * Defaults to the logical ID verbatim (variant names are user-facing URL
   * segments, so no uniqueness suffix is appended). Changing the name
   * triggers a replacement — the API cannot rename a variant.
   *
   * @default the logical ID
   */
  name?: string;
  /**
   * How the image is resized to fit the `width`x`height` box. Mutable.
   */
  fit: VariantFit;
  /**
   * Maximum width in pixels (1-9999). Mutable.
   */
  width: number;
  /**
   * Maximum height in pixels (1-9999). Mutable.
   */
  height: number;
  /**
   * What EXIF metadata is preserved on the served image. Mutable.
   * @default "none"
   */
  metadata?: VariantMetadata;
  /**
   * If `true`, this variant can serve an image without a signed URL even
   * when the image itself requires signed URLs. Mutable.
   * @default false
   */
  neverRequireSignedURLs?: boolean;
}

export interface VariantAttributes {
  /** The variant's name (its API path identifier and URL segment). */
  variantName: string;
  /** Account the variant belongs to. */
  accountId: string;
  /** How the image is resized. */
  fit: VariantFit;
  /** Maximum width in pixels. */
  width: number;
  /** Maximum height in pixels. */
  height: number;
  /** EXIF metadata handling. */
  metadata: VariantMetadata;
  /** Whether the variant bypasses signed-URL requirements. */
  neverRequireSignedURLs: boolean;
}

export type Variant = Resource<
  TypeId,
  VariantProps,
  VariantAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Images variant — a named resizing preset (e.g. `thumbnail`,
 * `hero`) applied when serving images from Cloudflare Images.
 *
 * A variant is identified by its name within an account (up to 100 variants
 * per account). The name is the URL segment used to request the variant, so
 * it is immutable — changing it triggers a replacement. All resizing options
 * (`fit`, `width`, `height`, `metadata`, `neverRequireSignedURLs`) are
 * mutable in place.
 *
 * Note: every Images-enabled account has a built-in `public` variant. Do not
 * manage `public` with this resource — Cloudflare silently ignores deletes
 * of the built-in variant, so destroy would not actually remove it.
 * @resource
 * @product Images
 * @category Media
 * @section Creating a Variant
 * @example Thumbnail variant
 * ```typescript
 * // Variant names are alphanumeric only (no hyphens/underscores).
 * const thumbnail = yield* Cloudflare.Images.Variant("thumbnail", {
 *   fit: "cover",
 *   width: 100,
 *   height: 100,
 * });
 * ```
 *
 * @example Hero variant with explicit name and metadata
 * ```typescript
 * const hero = yield* Cloudflare.Images.Variant("HeroImage", {
 *   name: "hero",
 *   fit: "scale-down",
 *   width: 1920,
 *   height: 1080,
 *   metadata: "copyright",
 * });
 * ```
 *
 * @section Signed URLs
 * @example Public variant for protected images
 * ```typescript
 * // Serve this variant without a signature even when the image itself
 * // requires signed URLs (e.g. for public thumbnails of private images).
 * const preview = yield* Cloudflare.Images.Variant("preview", {
 *   fit: "contain",
 *   width: 320,
 *   height: 240,
 *   neverRequireSignedURLs: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/images/manage-images/create-variants/
 */
export const Variant = Resource<Variant>(TypeId);

/**
 * Returns true if the given value is an Variant resource.
 */
export const isVariant = (value: unknown): value is Variant =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const VariantProvider = () =>
  Provider.succeed(Variant, {
    stables: ["variantName", "accountId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Enumerate variant names from the account-scoped list endpoint, then
      // hydrate each via the per-variant GET (whose schema is correct) into
      // the exact `read` Attributes shape.
      //
      // NOTE: distilled mis-types this response as a single variant, but the
      // real body is a keyed `variants` map — so the strict decode currently
      // fails. The fix is a distilled response-schema patch (see neededPatch
      // in the agent report); once applied, the successful-decode path below
      // works unchanged.
      const names = yield* images.listV1Variants({ accountId }).pipe(
        Effect.map(variantNamesFrom),
        // The built-in `public` variant is not managed by this resource —
        // Cloudflare silently ignores deletes of it (the DELETE returns 200
        // but the variant persists), so exclude it from enumeration.
        Effect.map((all) => all.filter((name) => name !== "public")),
        // Accounts without the Cloudflare Images entitlement reject the route
        // (code 5403) — there is nothing to enumerate.
        Effect.catchTag("ImagesAccessNotEnabled", () =>
          Effect.succeed<string[]>([]),
        ),
      );

      const rows = yield* Effect.forEach(
        names,
        (name) =>
          getVariant(accountId, name).pipe(
            Effect.map((variant) =>
              variant ? toAttributes(variant, accountId) : undefined,
            ),
          ),
        { concurrency: 10 },
      );

      return rows.filter((row): row is VariantAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      // News may still contain unresolved plan-time expressions — defer to
      // the engine's default update logic until everything is concrete.
      if (!isResolved(news)) return undefined;
      // The variant name is its API path identifier — it cannot be renamed.
      const oldName = output?.variantName ?? olds?.name ?? id;
      if ((news.name ?? id) !== oldName) {
        return { action: "replace" } as const;
      }
      // Moving accounts replaces. accountId is an Input — compare only once
      // both sides are concrete strings.
      if (
        typeof olds?.accountId === "string" &&
        typeof news.accountId === "string" &&
        olds.accountId !== news.accountId
      ) {
        return { action: "replace" } as const;
      }
      if (
        output?.accountId !== undefined &&
        typeof news.accountId === "string" &&
        news.accountId !== output.accountId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct =
        output?.accountId ??
        (olds?.accountId as string | undefined) ??
        accountId;
      const name = output?.variantName ?? olds?.name ?? id;

      const observed = yield* getVariant(acct, name);
      if (!observed) return undefined;
      const attrs = toAttributes(observed, acct);
      // Variants carry no ownership markers. With no prior output we cannot
      // prove we created a same-named variant — report it `Unowned` so the
      // engine gates takeover behind the adopt policy.
      return output?.variantName ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const acct = (news.accountId as string | undefined) ?? accountId;
      const name = news.name ?? id;

      // 1. Observe — cloud state is authoritative. The cached output is only
      //    a hint; a missing variant falls through to create.
      let observed = yield* getVariant(acct, name);

      // 2. Ensure — create when missing. A concurrent create surfaces as
      //    `VariantAlreadyExists` (Cloudflare code 5409): converge by
      //    re-reading the variant that won the race.
      if (!observed) {
        observed = yield* images
          .createV1Variant({
            accountId: acct,
            id: name,
            options: desiredOptions(news),
            neverRequireSignedURLs: news.neverRequireSignedURLs,
          })
          .pipe(
            Effect.map((created) => created.variant ?? undefined),
            Effect.catchTag("VariantAlreadyExists", () =>
              getVariant(acct, name),
            ),
          );
      }
      if (!observed) {
        // Create succeeded but neither the response body nor a re-read
        // surfaced the variant — eventual-consistency blip; fail typed so
        // the engine can retry the reconcile.
        return yield* Effect.fail(
          new images.VariantNotFound({
            code: 5401,
            message: `variant ${name} not observable after create`,
          }),
        );
      }

      // 3. Sync — diff observed options against desired; PATCH requires the
      //    full options struct, so send everything, but skip the API call
      //    entirely on a no-op.
      const desired = desiredOptions(news);
      const desiredSigned = news.neverRequireSignedURLs ?? false;
      const dirty =
        observed.options.fit !== desired.fit ||
        observed.options.width !== desired.width ||
        observed.options.height !== desired.height ||
        observed.options.metadata !== desired.metadata ||
        (observed.neverRequireSignedURLs ?? false) !== desiredSigned;

      if (dirty) {
        const patched = yield* images.patchV1Variant({
          accountId: acct,
          variantId: name,
          options: desired,
          neverRequireSignedURLs: desiredSigned,
        });
        observed = patched.variant ?? observed;
      }

      return toAttributes(observed, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* images
        .deleteV1Variant({
          accountId: output.accountId,
          variantId: output.variantName,
        })
        .pipe(Effect.catchTag("VariantNotFound", () => Effect.void));

      // Cloudflare's variant DELETE is eventually consistent: the GET
      // endpoint keeps returning the variant for a short window after a
      // successful delete. Confirm it is actually gone before reporting
      // success, so the engine's replacement GC (which deletes the OLD
      // generation as the new one is created) leaves a genuinely clean slate
      // rather than an orphan that lingers past the caller's verification.
      // Bounded — if it never clears we stop polling and proceed.
      yield* getVariant(output.accountId, output.variantName).pipe(
        Effect.repeat({
          schedule: Schedule.max([
            Schedule.exponential("500 millis"),
            Schedule.recurs(12),
          ]),
          until: (observed) => observed === undefined,
        }),
      );
    }),
  });

type ObservedVariant = NonNullable<images.GetV1VariantResponse["variant"]>;

/**
 * Read a variant by name, mapping "gone" (`VariantNotFound` — Cloudflare
 * error code 5401, or the envelope-less plain-text 404 the GET endpoint
 * returns) to `undefined`.
 */
const getVariant = (accountId: string, variantId: string) =>
  images.getV1Variant({ accountId, variantId }).pipe(
    Effect.map((response) => response.variant ?? undefined),
    Effect.catchTag("VariantNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Extract variant names — the keys of the `variants` map — from a list-variants
 * payload. The endpoint returns `result.variants` as a keyed object map of
 * variantId -> variant (not an array), so accept either the unwrapped `result`
 * (`{ variants: {...} }`) or the full raw body (`{ result: { variants: {...} } }`).
 */
const variantNamesFrom = (value: unknown): string[] => {
  const root =
    Predicate.hasProperty(value, "result") &&
    typeof value.result === "object" &&
    value.result !== null
      ? value.result
      : value;
  if (
    Predicate.hasProperty(root, "variants") &&
    typeof root.variants === "object" &&
    root.variants !== null
  ) {
    return Object.keys(root.variants);
  }
  return [];
};

const desiredOptions = (news: VariantProps) => ({
  fit: news.fit,
  width: news.width,
  height: news.height,
  metadata: news.metadata ?? ("none" as const),
});

const toAttributes = (
  variant: ObservedVariant,
  accountId: string,
): VariantAttributes => ({
  variantName: variant.id,
  accountId,
  // Distilled widens generated string enums to open unions (`string & {}`).
  fit: variant.options.fit as VariantFit,
  width: variant.options.width,
  height: variant.options.height,
  metadata: variant.options.metadata as VariantMetadata,
  neverRequireSignedURLs: variant.neverRequireSignedURLs ?? false,
});
