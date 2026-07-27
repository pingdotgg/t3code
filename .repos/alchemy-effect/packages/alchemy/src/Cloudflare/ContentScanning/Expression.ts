import * as contentScanning from "@distilled.cloud/cloudflare/content-scanning";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ContentScanning.Expression" as const;
type TypeId = typeof TypeId;

export interface ExpressionProps {
  /**
   * Zone the custom scan expression belongs to. Stable — moving an
   * expression between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * Ruleset-language expression that locates the content to scan inside
   * the request — e.g.
   * `lookup_json_string(http.request.body.raw, "file")`.
   *
   * Immutable — the API has no update endpoint for expressions, so
   * changing the payload triggers a replacement (create new, delete old).
   */
  payload: string;
}

export interface ExpressionAttributes {
  /** Cloudflare-assigned identifier of the custom scan expression. */
  expressionId: string;
  /** Zone the expression belongs to. */
  zoneId: string;
  /** The ruleset-language expression locating the content to scan. */
  payload: string;
}

export type Expression = Resource<
  TypeId,
  ExpressionProps,
  ExpressionAttributes,
  never,
  Providers
>;

/**
 * A custom scan expression ("payload") for WAF Content Scanning — tells the
 * malicious-uploads scanner where to find encoded or nested content in the
 * request body (`/zones/{zone_id}/content-upload-scan/payloads`).
 *
 * An expression's identity is its `payload` text within the zone: the API
 * offers create/list/delete only (no update), so changing `payload`
 * triggers a replacement. The zone must have Content Scanning enabled (see
 * `Cloudflare.ContentScanning.ContentScanning`) — payload calls on a zone where scanning is
 * disabled fail with the typed `ContentScanningNotEnabled` error.
 *
 * Safety: expressions carry no ownership markers. When there is no prior
 * state, `read` scans the zone for an expression with the same payload text
 * and reports it as `Unowned`, so the engine refuses to take it over unless
 * `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Content Scanning
 * @category Application Security
 * @section Creating expressions
 * @example Scan a JSON-embedded file field
 * ```typescript
 * const scanning = yield* Cloudflare.ContentScanning.ContentScanning("UploadScanning", {
 *   zoneId: zone.zoneId,
 * });
 *
 * yield* Cloudflare.ContentScanning.Expression("ScanJsonFile", {
 *   zoneId: scanning.zoneId,
 *   payload: 'lookup_json_string(http.request.body.raw, "file")',
 * });
 * ```
 *
 * @example Scan a base64-encoded form field
 * ```typescript
 * yield* Cloudflare.ContentScanning.Expression("ScanBase64Document", {
 *   zoneId: scanning.zoneId,
 *   payload: 'base64_decode(http.request.body.form["document"][0])',
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/detections/malicious-uploads/#add-custom-scan-expressions
 */
export const Expression = Resource<Expression>(TypeId);

/**
 * Returns true if the given value is a Expression resource.
 */
export const isExpression = (value: unknown): value is Expression =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Cloudflare accepted the create call but the expression did not appear in
 * the returned list — an API anomaly that should never happen in practice.
 */
export class ExpressionCreateAnomaly extends Data.TaggedError(
  "ExpressionCreateAnomaly",
)<{
  readonly zoneId: string;
  readonly payload: string;
}> {}

export const ExpressionProvider = () =>
  Provider.succeed(Expression, {
    stables: ["expressionId", "zoneId", "payload"],

    // Custom scan expressions are a zone-scoped Content Scanning feature. Fan
    // out over every zone in the account, exhaustively paginate each zone's
    // payloads, and hydrate each into the same Attributes shape `read`
    // produces. Zones without Content Scanning enabled (or not entitled) reject
    // payload calls with the typed `ContentScanningNotEnabled`/`Forbidden`
    // tags, and a deleted zone with `InvalidRoute` — skip all three.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones,
        (zone) =>
          contentScanning.listPayloads.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((expression) =>
                  toAttributes(zone.id, expression),
                ),
              ),
            ),
            Effect.catchTag("ContentScanningNotEnabled", () =>
              Effect.succeed([]),
            ),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
            Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      // zoneId is Input<string>; compare only once both sides are concrete.
      if (!isResolved(news)) return undefined;
      const old = olds !== undefined && isResolved(olds) ? olds : undefined;
      // The payload is the expression's identity — no update endpoint.
      const oldPayload = output?.payload ?? old?.payload;
      if (oldPayload !== undefined && oldPayload !== news.payload) {
        return { action: "replace" } as const;
      }
      const oldZoneId = output?.zoneId ?? old?.zoneId;
      if (oldZoneId !== undefined && oldZoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;

      const expressions = yield* listExpressions(zoneId);
      // Scanning disabled or zone gone — no expressions are observable.
      if (expressions === undefined) return undefined;

      // Owned path: refresh by our persisted expression id.
      if (output?.expressionId) {
        const observed = expressions.find((e) => e.id === output.expressionId);
        if (observed) return toAttributes(zoneId, observed);
      }

      // Adoption path: an expression with this payload text may already
      // exist on the zone. Expressions carry no ownership markers, so we
      // cannot prove we created it — brand it `Unowned` so the engine
      // refuses to take over unless `adopt` is set.
      const payload = output?.payload ?? olds?.payload;
      if (payload !== undefined) {
        const observed = expressions.find((e) => e.payload === payload);
        if (observed) return Unowned(toAttributes(zoneId, observed));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the expression id cached on `output` is a hint, not
      //    a guarantee: a missing expression falls through to the payload
      //    scan and then to create. (Scanning must be enabled here — a
      //    disabled zone fails with the typed ContentScanningNotEnabled.)
      const expressionId = output?.expressionId;
      let observed: ObservedExpression | undefined = expressionId
        ? yield* findExpression(zoneId, (e) => e.id === expressionId)
        : undefined;

      // 2. Fall back to matching by payload text. Ownership has already
      //    been verified upstream — `read` reports existing expressions as
      //    `Unowned` and the engine gates takeover behind the adopt policy
      //    before reconcile ever runs.
      if (!observed) {
        observed = yield* findExpression(
          zoneId,
          (e) => e.payload === news.payload,
        );
      }

      // 3. Ensure — create when missing. The create call returns the full
      //    list of expressions; find ours by payload text.
      if (!observed) {
        const created = yield* contentScanning.createPayload({
          zoneId,
          body: [{ payload: news.payload }],
        });
        observed = created.result.find((e) => e.payload === news.payload);
        if (!observed) {
          return yield* Effect.fail(
            new ExpressionCreateAnomaly({
              zoneId,
              payload: news.payload,
            }),
          );
        }
      }

      // 4. No sync step — expressions have nothing mutable beyond identity.
      return toAttributes(zoneId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, expressionId } = output;
      // Observe first — scanning disabled / zone gone / already deleted
      // all mean there is nothing left to remove.
      const expressions = yield* listExpressions(zoneId);
      if (expressions === undefined) return;
      if (!expressions.some((e) => e.id === expressionId)) return;
      yield* contentScanning.deletePayload({ zoneId, expressionId }).pipe(
        // A concurrent disable between observe and delete is "gone".
        Effect.catchTag("ContentScanningNotEnabled", () => Effect.void),
        Effect.catchTag("InvalidRoute", () => Effect.void),
      );
    }),
  });

type ObservedExpression = { id?: string | null; payload?: string | null };

/**
 * Find the first expression on the zone matching `predicate`, terminating
 * pagination as soon as a match is seen. Unlike {@link listExpressions},
 * "not observable" errors propagate (reconcile requires scanning enabled).
 */
const findExpression = (
  zoneId: string,
  predicate: (e: ObservedExpression) => boolean,
) =>
  contentScanning.listPayloads
    .items({ zoneId })
    .pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

/**
 * List the zone's custom scan expressions, mapping "not observable"
 * (scanning disabled on the zone, or the zone itself gone) to `undefined`.
 */
const listExpressions = (zoneId: string) =>
  contentScanning.listPayloads.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk): readonly ObservedExpression[] | undefined =>
      Array.from(chunk),
    ),
    Effect.catchTag("ContentScanningNotEnabled", () =>
      Effect.succeed(undefined),
    ),
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );

const toAttributes = (
  zoneId: string,
  expression: ObservedExpression,
): ExpressionAttributes => ({
  // Cloudflare always echoes both fields for a persisted expression.
  expressionId: expression.id ?? "",
  zoneId,
  payload: expression.payload ?? "",
});
