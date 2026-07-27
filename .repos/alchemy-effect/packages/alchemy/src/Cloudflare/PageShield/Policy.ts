import * as pageShield from "@distilled.cloud/cloudflare/page-shield";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.PageShield.Policy" as const;
type TypeId = typeof TypeId;

/**
 * Action a Page Shield policy takes when its expression matches:
 * `allow` blocks everything not covered by the CSP, `log` only reports
 * violations, and `add_reporting_directives` injects report-to /
 * report-uri directives.
 */
export type PolicyAction = "allow" | "log" | "add_reporting_directives";

export interface PolicyProps {
  /**
   * Zone the policy belongs to. Stable — changing the zone triggers a
   * replacement.
   */
  zoneId: string;
  /**
   * Human readable description of the policy. Page Shield policies have
   * no `name` field, so the description doubles as the resource's
   * identity for cold-state recovery. If omitted, a deterministic name
   * is generated from the app, stage, and logical ID. Mutable.
   * @default ${app}-${stage}-${id}
   */
  description?: string;
  /**
   * The action to take when `expression` matches: `allow` (enforce the
   * CSP), `log` (report only), or `add_reporting_directives`. Mutable.
   */
  action: PolicyAction;
  /**
   * Whether the policy is enabled. Mutable.
   * @default true
   */
  enabled?: boolean;
  /**
   * The expression that must match for the policy to be applied, in
   * Cloudflare's Firewall rule expression syntax (e.g.
   * `http.host eq "example.com"`). Mutable.
   */
  expression: string;
  /**
   * The Content Security Policy to apply (e.g. `script-src 'self'`).
   * Mutable.
   */
  value: string;
}

export interface PolicyAttributes {
  /** Auto-assigned identifier of the policy. */
  policyId: string;
  /** Zone the policy belongs to. */
  zoneId: string;
  /** The action taken when the expression matches. */
  action: PolicyAction;
  /** Human readable description of the policy. */
  description: string;
  /** Whether the policy is enabled. */
  enabled: boolean;
  /** The expression that must match for the policy to be applied. */
  expression: string;
  /** The Content Security Policy applied by this policy. */
  value: string;
}

export type Policy = Resource<
  TypeId,
  PolicyProps,
  PolicyAttributes,
  never,
  Providers
>;

/**
 * A Page Shield policy — a Content Security Policy rule
 * (`/zones/{zone_id}/page_shield/policies`) that is applied when its
 * expression matches a request.
 *
 * Policies let you enforce (or log violations of) a CSP at the edge,
 * positively blocking resources Page Shield hasn't approved. All fields
 * are mutable in place; only the zone forces a replacement.
 *
 * **Entitlement-gated**: CSP policies are an Enterprise add-on. On
 * non-entitled zones, creation fails with the typed `PolicyQuotaExceeded`
 * error ("exceeded the maximum number of rules in the phase
 * http_response_page_shield: 1 out of 0"). Page Shield itself should be
 * enabled on the zone first — see `Cloudflare.PageShield.Settings`.
 * @resource
 * @product Page Shield
 * @category Application Security
 * @section Creating a Policy
 * @example Log-only CSP policy
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.PageShield.Settings("PageShield", {
 *   zoneId: zone.zoneId,
 * });
 *
 * yield* Cloudflare.PageShield.Policy("LogScripts", {
 *   zoneId: zone.zoneId,
 *   action: "log",
 *   expression: 'http.host eq "example.com"',
 *   value: "script-src 'self'",
 * });
 * ```
 *
 * @example Enforcing CSP policy with a description
 * ```typescript
 * yield* Cloudflare.PageShield.Policy("EnforceScripts", {
 *   zoneId: zone.zoneId,
 *   description: "block third-party scripts on checkout",
 *   action: "allow",
 *   expression: 'starts_with(http.request.uri.path, "/checkout")',
 *   value: "script-src 'self' https://js.stripe.com",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/page-shield/policies/
 */
export const Policy = Resource<Policy>(TypeId);

/**
 * Returns true if the given value is a Policy resource.
 */
export const isPolicy = (value: unknown): value is Policy =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["policyId", "zoneId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined && output.zoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (!zoneId) return undefined;

      if (output?.policyId) {
        const observed = yield* getPolicy(zoneId, output.policyId);
        return observed ? toAttributes(zoneId, observed) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // description (policies have no name and carry no tags, so the
      // description is the best identity we have). A match is branded
      // `Unowned` so the engine gates takeover behind `--adopt`.
      const description = yield* createDescription(id, olds?.description);
      const list = yield* pageShield.listPolicies({ zoneId });
      const match = list.result.find((p) => p.description === description);
      return match ? Unowned(toAttributes(zoneId, match)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const description = yield* createDescription(id, news.description);

      // 1. Observe — the policyId cached on `output` is a hint, not a
      //    guarantee: a PolicyNotFound falls through to "missing".
      const observed = output?.policyId
        ? yield* getPolicy(zoneId, output.policyId)
        : undefined;

      const desired = {
        action: news.action,
        description,
        enabled: news.enabled ?? true,
        expression: news.expression,
        value: news.value,
      };

      // 2. Ensure — greenfield (or out-of-band delete): create with the
      //    full desired body. Descriptions are not unique on Cloudflare's
      //    side, so there is no AlreadyExists race to tolerate.
      if (!observed) {
        const created = yield* pageShield.createPolicy({ zoneId, ...desired });
        return toAttributes(zoneId, created);
      }

      // 3. Sync — diff observed cloud state against desired; the update
      //    API is a PUT, so send the full body, but skip the call
      //    entirely on a no-op.
      const dirty =
        observed.action !== desired.action ||
        observed.description !== desired.description ||
        observed.enabled !== desired.enabled ||
        observed.expression !== desired.expression ||
        observed.value !== desired.value;
      if (!dirty) {
        return toAttributes(zoneId, observed);
      }
      const updated = yield* pageShield.updatePolicy({
        zoneId,
        policyId: observed.id,
        ...desired,
      });
      return toAttributes(zoneId, updated);
    }),

    list: Effect.fn(function* () {
      // Page Shield policies are zone-scoped
      // (`/zones/{zone_id}/page_shield/policies`). Fan out across every
      // zone in the account, exhaustively paginate each, and hydrate into
      // the same Attributes shape `read` produces. Zones without Page
      // Shield entitlement reject with the typed `Forbidden` tag — skip
      // them rather than failing the whole enumeration.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          pageShield.listPolicies.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((policy) =>
                  toAttributes(zone.id, policy),
                ),
              ),
            ),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare returns 204 even for missing policies, but ride out a
      // racing delete via the typed tag anyway.
      yield* pageShield
        .deletePolicy({ zoneId: output.zoneId, policyId: output.policyId })
        .pipe(Effect.catchTag("PolicyNotFound", () => Effect.void));
    }),
  });

/**
 * Read a policy by id, mapping "gone" (`PolicyNotFound`, HTTP 404) to
 * `undefined`.
 */
const getPolicy = (zoneId: string, policyId: string) =>
  pageShield
    .getPolicy({ zoneId, policyId })
    .pipe(Effect.catchTag("PolicyNotFound", () => Effect.succeed(undefined)));

const createDescription = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    return description ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

type ObservedPolicy =
  | pageShield.GetPolicyResponse
  | pageShield.CreatePolicyResponse
  | pageShield.UpdatePolicyResponse
  | pageShield.ListPoliciesResponse["result"][number];

const toAttributes = (
  zoneId: string,
  policy: ObservedPolicy,
): PolicyAttributes => ({
  policyId: policy.id,
  zoneId,
  // Distilled widens generated string enums to open unions (`string & {}`).
  action: policy.action as PolicyAction,
  description: policy.description,
  enabled: policy.enabled,
  expression: policy.expression,
  value: policy.value,
});
