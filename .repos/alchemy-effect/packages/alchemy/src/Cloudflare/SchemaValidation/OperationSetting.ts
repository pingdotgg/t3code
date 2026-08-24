import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.SchemaValidation.OperationSetting" as const;
type TypeId = typeof TypeId;

/**
 * Per-operation mitigation action for schema validation: `log` records
 * non-conforming requests, `block` denies them, `none` does nothing.
 */
export type OperationMitigationAction = "log" | "block" | "none";

export interface OperationSettingProps {
  /**
   * Zone the operation belongs to.
   *
   * Immutable — changing the zone triggers a replacement.
   */
  zoneId: string;
  /**
   * UUID of the API Shield operation the override applies to (cross-resource
   * reference to `Cloudflare.ApiShield.Operation`).
   *
   * Immutable — the operation is the override's identity, so changing it
   * triggers a replacement.
   */
  operationId: string;
  /**
   * The mitigation action applied to this operation, superseding the zone
   * default just for this operation: `log` records non-conforming requests,
   * `block` denies them, `none` disables validation for the operation.
   * Mutable in place (the PUT is a true upsert). `log` may be plan-gated
   * (API Shield entitlement).
   */
  mitigationAction: OperationMitigationAction;
}

export interface OperationSettingAttributes {
  /** Zone the operation belongs to. */
  zoneId: string;
  /** UUID of the API Shield operation the override applies to. */
  operationId: string;
  /** The mitigation action applied to this operation. */
  mitigationAction: OperationMitigationAction;
}

export type OperationSetting = Resource<
  TypeId,
  OperationSettingProps,
  OperationSettingAttributes,
  never,
  Providers
>;

/**
 * A per-operation schema validation override
 * (`/zones/{zone_id}/schema_validation/settings/operations/{operation_id}`)
 * — pins a mitigation action for a single API Shield operation, superseding
 * the zone-level default just for that operation.
 *
 * The override is keyed by the operation's UUID; deleting the resource
 * clears the override so the operation falls back to the zone default.
 * Deleting the underlying API Shield operation cascades the override away.
 * @resource
 * @product Schema Validation
 * @category Application Security
 * @section Overriding an operation
 * @example Block non-conforming requests on one operation
 * ```typescript
 * const op = yield* Cloudflare.ApiShield.Operation("GetUser", {
 *   zoneId: zone.zoneId,
 *   method: "GET",
 *   host: "api.example.com",
 *   endpoint: "/users/{id}",
 * });
 *
 * yield* Cloudflare.SchemaValidation.OperationSetting("BlockGetUser", {
 *   zoneId: zone.zoneId,
 *   operationId: op.operationId,
 *   mitigationAction: "block",
 * });
 * ```
 *
 * @example Exempt an operation from validation
 * ```typescript
 * yield* Cloudflare.SchemaValidation.OperationSetting("SkipWebhook", {
 *   zoneId: zone.zoneId,
 *   operationId: webhookOp.operationId,
 *   mitigationAction: "none",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/security/schema-validation/
 */
export const OperationSetting = Resource<OperationSetting>(TypeId);

/**
 * Returns true if the given value is a OperationSetting
 * resource.
 */
export const isOperationSetting = (value: unknown): value is OperationSetting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const OperationSettingProvider = () =>
  Provider.succeed(OperationSetting, {
    stables: ["zoneId", "operationId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Per-operation overrides live inside a zone with no account-wide
      // enumeration API — fan out over every zone and list its operation
      // settings, exhaustively paginated.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          schemaValidation.listSettingOperations
            .pages({ zoneId: zone.id })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? [])
                    // An operation with no override reports a nullish action;
                    // skip it so the result mirrors what `read` returns.
                    .filter((op) => op.mitigationAction != null)
                    .map((op) =>
                      toAttributes(zone.id, {
                        operationId: op.operationId,
                        // Distilled widens the generated enum to an open union.
                        mitigationAction:
                          op.mitigationAction as OperationMitigationAction,
                      }),
                    ),
                ),
              ),
              // A zone with no API Shield / schema-validation entitlement
              // rejects the route — skip it, keep the rest. (Transient
              // code-10000 "Authentication error" blips under concurrency are
              // retried globally by the Cloudflare retry policy, so they never
              // reach here as a real failure.)
              Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // The (zoneId, operationId) pair is the override's identity.
      if (
        output?.zoneId !== undefined &&
        typeof news.zoneId === "string" &&
        news.zoneId !== output.zoneId
      ) {
        return { action: "replace" } as const;
      }
      if (
        output?.operationId !== undefined &&
        typeof news.operationId === "string" &&
        news.operationId !== output.operationId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      const operationId =
        output?.operationId ??
        (typeof olds?.operationId === "string" ? olds.operationId : undefined);
      if (zoneId === undefined || operationId === undefined) return undefined;

      const observed = yield* getOperationSetting(zoneId, operationId);
      if (observed === undefined) return undefined;
      const attrs = toAttributes(zoneId, observed);
      // An override carries no ownership marker. When we have no prior
      // output (cold read), an existing override was set out-of-band —
      // brand it `Unowned` so the engine gates takeover behind adoption.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const operationId = news.operationId as string;

      // 1. Observe — an absent override (`OperationNotFound` on an
      //    operation with no override) simply means "not set yet".
      const observed = yield* getOperationSetting(zoneId, operationId);

      // 2/3. Ensure + Sync — the PUT is a true upsert, so a single call
      //    converges both the greenfield and the drifted case. Skip it
      //    entirely on a no-op.
      if (observed?.mitigationAction === news.mitigationAction) {
        return toAttributes(zoneId, observed);
      }
      const updated = yield* schemaValidation.putSettingOperation({
        zoneId,
        operationId,
        mitigationAction: news.mitigationAction,
      });
      return toAttributes(zoneId, {
        operationId: updated.operationId,
        // Distilled widens the generated enum to an open union.
        mitigationAction: updated.mitigationAction as OperationMitigationAction,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — clearing an already-cleared override (or one that
      // cascaded away with its operation) is success.
      yield* schemaValidation
        .deleteSettingOperation({
          zoneId: output.zoneId,
          operationId: output.operationId,
        })
        .pipe(Effect.catchTag("OperationNotFound", () => Effect.void));
    }),
  });

/**
 * Read an operation override, mapping both "gone" shapes to `undefined`:
 * `OperationNotFound` (code 10404) when the operation itself does not
 * exist, and a 200 response without `mitigation_action` when the operation
 * exists but carries no override.
 */
const getOperationSetting = (zoneId: string, operationId: string) =>
  schemaValidation.getSettingOperation({ zoneId, operationId }).pipe(
    Effect.map((setting) =>
      setting.mitigationAction == null
        ? undefined
        : {
            operationId: setting.operationId,
            // Distilled widens the generated enum to an open union.
            mitigationAction:
              setting.mitigationAction as OperationMitigationAction,
          },
    ),
    Effect.catchTag("OperationNotFound", () => Effect.succeed(undefined)),
  );

const toAttributes = (
  zoneId: string,
  setting: {
    operationId: string;
    mitigationAction: OperationMitigationAction;
  },
): OperationSettingAttributes => ({
  zoneId,
  operationId: setting.operationId,
  mitigationAction: setting.mitigationAction,
});
