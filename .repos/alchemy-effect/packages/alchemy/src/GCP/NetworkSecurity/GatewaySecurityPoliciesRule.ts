import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  NetworksecurityNotResolved,
  canonicalizeLink,
  changedFields,
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  linkKey,
  normalizeLocation,
  parentOf,
  parseName,
  parseOwnership,
  rfc1035,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "rules";

export type GatewaySecurityPolicyRuleBasicProfile =
  | networksecurity.GatewaySecurityPolicyRuleBasicProfileEnum
  | (string & {});

export type GatewaySecurityPoliciesRuleProps = {
  /**
   * Parent GatewaySecurityPolicy resource name
   * (`projects/{project}/locations/{location}/gatewaySecurityPolicies/{gatewaySecurityPolicy}`)
   * or the policy id. Immutable — changing it replaces the rule.
   */
  gatewaySecurityPolicy: string;
  /**
   * Rule id (the `{rule}` segment of
   * `.../gatewaySecurityPolicies/{gatewaySecurityPolicy}/rules/{rule}`).
   * If omitted, a unique RFC1035 name is generated. Must be 4-63
   * characters matching `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable —
   * changing it replaces the rule.
   */
  gatewaySecurityPolicyRuleId?: string;
  /**
   * Region of the parent policy. Inferred from
   * `gatewaySecurityPolicy` when that value is a full resource name.
   * Immutable — changing it replaces the rule.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Primitive action (`ALLOW` or `DENY`).
   */
  basicProfile: GatewaySecurityPolicyRuleBasicProfile;
  /**
   * Rule priority. Lower numbers take precedence.
   */
  priority: number;
  /**
   * Whether the rule is enforced.
   * @default true
   */
  enabled?: boolean;
  /**
   * CEL expression matching session criteria (L4).
   */
  sessionMatcher: string;
  /**
   * Optional CEL expression matching L7 / application criteria.
   */
  applicationMatcher?: string;
  /**
   * Enable TLS inspection for matching traffic. The parent policy must
   * reference a TlsInspectionPolicy.
   * @default false
   */
  tlsInspectionEnabled?: boolean;
  /**
   * Human-readable description. Rules have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
};

export type GatewaySecurityPoliciesRule = Resource<
  "GCP.NetworkSecurity.GatewaySecurityPoliciesRule",
  GatewaySecurityPoliciesRuleProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/gatewaySecurityPolicies/{gatewaySecurityPolicy}/rules/{rule}`. */
    name: string;
    /** Rule id (last path segment). */
    gatewaySecurityPolicyRuleId: string;
    /** Parent GatewaySecurityPolicy resource name. */
    gatewaySecurityPolicy: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** Primitive action (`ALLOW` or `DENY`). */
    basicProfile: string | undefined;
    /** Rule priority. */
    priority: number | undefined;
    /** Whether the rule is enforced. */
    enabled: boolean;
    /** Session-level CEL matcher. */
    sessionMatcher: string | undefined;
    /** Application-level CEL matcher, if set. */
    applicationMatcher: string | undefined;
    /** Whether TLS inspection is enabled. */
    tlsInspectionEnabled: boolean;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A GatewaySecurityPolicyRule nested under a GatewaySecurityPolicy.
 * Each rule matches traffic with CEL and applies ALLOW or DENY.
 *
 * The API has no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Changing the parent policy, rule id,
 * or location replaces the rule. Matchers, priority, profile, enabled
 * flag, TLS inspection, and description update in place.
 *
 * ### Creating a GatewaySecurityPoliciesRule
 * **Example:** Allow all sessions
 * ```typescript
 * const rule = yield* GCP.NetworkSecurity.GatewaySecurityPoliciesRule("Allow", {
 *   gatewaySecurityPolicy: policy.name,
 *   basicProfile: "ALLOW",
 *   priority: 1000,
 *   sessionMatcher: "true",
 * });
 * ```
 *
 * **Example:** Deny by host
 * ```typescript
 * const rule = yield* GCP.NetworkSecurity.GatewaySecurityPoliciesRule("Block", {
 *   gatewaySecurityPolicy: policy.name,
 *   basicProfile: "DENY",
 *   priority: 100,
 *   enabled: true,
 *   sessionMatcher: "host() == 'blocked.example.com'",
 *   description: "block listed host",
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const GatewaySecurityPoliciesRule =
  Resource<GatewaySecurityPoliciesRule>(
    "GCP.NetworkSecurity.GatewaySecurityPoliciesRule",
  );

const parentPolicyName = (
  project: string,
  location: string,
  gatewaySecurityPolicy: string,
) => {
  const canonical = canonicalizeLink(gatewaySecurityPolicy);
  if (canonical.includes("/gatewaySecurityPolicies/")) return canonical;
  return `projects/${project}/locations/${location}/gatewaySecurityPolicies/${canonical}`;
};

const resourceNameOf = (parent: string, ruleId: string) =>
  `${parent}/rules/${ruleId}`;

const parentFromRuleName = (name: string) => {
  const index = name.lastIndexOf("/rules/");
  return index >= 0 ? name.slice(0, index) : name;
};

const locationFromParent = (
  gatewaySecurityPolicy: string,
  fallback: string,
) => {
  const canonical = canonicalizeLink(gatewaySecurityPolicy);
  if (!canonical.includes("/locations/")) return fallback;
  return parseName(canonical, "gatewaySecurityPolicies", fallback).location;
};

const toAttrs = (
  rule: networksecurity.GatewaySecurityPolicyRule,
  project: string,
  region: string,
) => {
  const name = rule.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(rule.description);
  const parent = parentFromRuleName(name);
  return {
    name,
    gatewaySecurityPolicyRuleId: parsed.id,
    gatewaySecurityPolicy: parent,
    project: parsed.project || project,
    location: parsed.location || region,
    basicProfile: rule.basicProfile,
    priority: rule.priority,
    enabled: rule.enabled !== false,
    sessionMatcher: rule.sessionMatcher,
    applicationMatcher: rule.applicationMatcher,
    tlsInspectionEnabled: rule.tlsInspectionEnabled === true,
    description: ownership.text,
    createTime: rule.createTime,
    updateTime: rule.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsGatewaySecurityPoliciesRules({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const GatewaySecurityPoliciesRuleProvider = () =>
  Provider.succeed(GatewaySecurityPoliciesRule, {
    stables: [
      "name",
      "gatewaySecurityPolicyRuleId",
      "gatewaySecurityPolicy",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.gatewaySecurityPolicyRuleId ??
        output?.gatewaySecurityPolicyRuleId;
      const nextId = news.gatewaySecurityPolicyRuleId
        ? rfc1035(news.gatewaySecurityPolicyRuleId, "rule")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ??
          locationFromParent(news.gatewaySecurityPolicy, previousLocation),
        env.region,
      );
      const previousParent = linkKey(
        olds?.gatewaySecurityPolicy ?? output?.gatewaySecurityPolicy,
      );
      const nextParent = linkKey(news.gatewaySecurityPolicy);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousParent.length > 0 && previousParent !== nextParent)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.gatewaySecurityPolicy
            ? locationFromParent(olds.gatewaySecurityPolicy, env.region)
            : undefined),
        env.region,
      );
      const parent = parentPolicyName(
        env.project,
        location,
        olds?.gatewaySecurityPolicy ?? output?.gatewaySecurityPolicy ?? "",
      );
      const ruleId = yield* toPhysicalId(
        id,
        olds?.gatewaySecurityPolicyRuleId,
        output?.gatewaySecurityPolicyRuleId,
        "rule",
      );
      const name = output?.name ?? resourceNameOf(parent, ruleId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const policies = yield* collectPages(
          networksecurity.listProjectsLocationsGatewaySecurityPolicies.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.gatewaySecurityPolicies,
        );
        const nested = yield* Effect.forEach(
          policies.filter((policy) => (policy.name ?? "").length > 0),
          (policy) =>
            collectPages(
              networksecurity.listProjectsLocationsGatewaySecurityPoliciesRules.pages(
                {
                  parent: policy.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.gatewaySecurityPolicyRules,
            ),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromParent(news.gatewaySecurityPolicy, env.region),
        env.region,
      );
      const parent = parentPolicyName(
        env.project,
        location,
        news.gatewaySecurityPolicy,
      );
      const ruleId = yield* toPhysicalId(
        id,
        news.gatewaySecurityPolicyRuleId,
        output?.gatewaySecurityPolicyRuleId,
        "rule",
      );
      const name = resourceNameOf(parent, ruleId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const enabled = news.enabled !== false;
      const tlsInspectionEnabled = news.tlsInspectionEnabled === true;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsGatewaySecurityPoliciesRules({
            parent,
            gatewaySecurityPolicyRuleId: ruleId,
            body: {
              basicProfile: news.basicProfile,
              priority: news.priority,
              enabled,
              sessionMatcher: news.sessionMatcher,
              applicationMatcher: news.applicationMatcher,
              tlsInspectionEnabled,
              description: desiredDescription,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new NetworksecurityNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const profileChanged = (current.basicProfile ?? "") !== news.basicProfile;
      const priorityChanged = (current.priority ?? 0) !== news.priority;
      const enabledChanged = (current.enabled !== false) !== enabled;
      const sessionChanged =
        (current.sessionMatcher ?? "") !== news.sessionMatcher;
      const applicationChanged =
        (current.applicationMatcher ?? "") !== (news.applicationMatcher ?? "");
      const tlsChanged =
        (current.tlsInspectionEnabled === true) !== tlsInspectionEnabled;
      const updateMask = changedFields([
        ["description", descriptionChanged],
        ["basicProfile", profileChanged],
        ["priority", priorityChanged],
        ["enabled", enabledChanged],
        ["sessionMatcher", sessionChanged],
        ["applicationMatcher", applicationChanged],
        ["tlsInspectionEnabled", tlsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networksecurity.patchProjectsLocationsGatewaySecurityPoliciesRules(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                description: desiredDescription,
                basicProfile: news.basicProfile,
                priority: news.priority,
                enabled,
                sessionMatcher: news.sessionMatcher,
                applicationMatcher: news.applicationMatcher,
                tlsInspectionEnabled,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsGatewaySecurityPoliciesRules({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
