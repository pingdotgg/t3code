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

const COLLECTION = "gatewaySecurityPolicies";

export type GatewaySecurityPolicyProps = {
  /**
   * GatewaySecurityPolicy id (the `{gatewaySecurityPolicy}` segment of
   * `projects/{project}/locations/{location}/gatewaySecurityPolicies/{gatewaySecurityPolicy}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the policy.
   */
  gatewaySecurityPolicyId?: string;
  /**
   * Region of the policy (`us-central1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description. GatewaySecurityPolicy has no labels
   * field, so Alchemy stamps ownership into a `[alchemy …]` prefix and
   * strips it from attributes.
   */
  description?: string;
  /**
   * TlsInspectionPolicy resource name used by rules that enable TLS
   * inspection.
   */
  tlsInspectionPolicy?: string;
};

export type GatewaySecurityPolicy = Resource<
  "GCP.NetworkSecurity.GatewaySecurityPolicy",
  GatewaySecurityPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/gatewaySecurityPolicies/{gatewaySecurityPolicy}`. */
    name: string;
    /** GatewaySecurityPolicy id (last path segment). */
    gatewaySecurityPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Attached TlsInspectionPolicy resource name, if any. */
    tlsInspectionPolicy: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Gateway Security Policy — a collection of
 * GatewaySecurityPolicyRules used by Secure Web Proxy.
 *
 * The API has no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Changing `gatewaySecurityPolicyId` or
 * `location` replaces the policy. Description and `tlsInspectionPolicy`
 * update in place.
 *
 * ### Creating a GatewaySecurityPolicy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.GatewaySecurityPolicy("Swp", {
 *   description: "secure web proxy",
 * });
 * ```
 *
 * **Example:** Named policy with TLS inspection
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.GatewaySecurityPolicy("Swp", {
 *   gatewaySecurityPolicyId: "app-swp",
 *   location: "us-central1",
 *   tlsInspectionPolicy: inspection.name,
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const GatewaySecurityPolicy = Resource<GatewaySecurityPolicy>(
  "GCP.NetworkSecurity.GatewaySecurityPolicy",
);

const resourceName = (
  project: string,
  location: string,
  gatewaySecurityPolicyId: string,
) =>
  `projects/${project}/locations/${location}/gatewaySecurityPolicies/${gatewaySecurityPolicyId}`;

const toAttrs = (
  policy: networksecurity.GatewaySecurityPolicy,
  project: string,
  region: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(policy.description);
  return {
    name,
    gatewaySecurityPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    description: ownership.text,
    tlsInspectionPolicy: policy.tlsInspectionPolicy
      ? canonicalizeLink(policy.tlsInspectionPolicy)
      : undefined,
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsGatewaySecurityPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const GatewaySecurityPolicyProvider = () =>
  Provider.succeed(GatewaySecurityPolicy, {
    stables: [
      "name",
      "gatewaySecurityPolicyId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.gatewaySecurityPolicyId ?? output?.gatewaySecurityPolicyId;
      const nextId = news.gatewaySecurityPolicyId
        ? rfc1035(news.gatewaySecurityPolicyId, "gateway-security-policy")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewaySecurityPolicyId = yield* toPhysicalId(
        id,
        olds?.gatewaySecurityPolicyId,
        output?.gatewaySecurityPolicyId,
        "gateway-security-policy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, gatewaySecurityPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networksecurity.listProjectsLocationsGatewaySecurityPolicies.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.gatewaySecurityPolicies,
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewaySecurityPolicyId = yield* toPhysicalId(
        id,
        news.gatewaySecurityPolicyId,
        output?.gatewaySecurityPolicyId,
        "gateway-security-policy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, gatewaySecurityPolicyId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const tlsInspectionPolicy = news.tlsInspectionPolicy
        ? canonicalizeLink(news.tlsInspectionPolicy)
        : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsGatewaySecurityPolicies({
            parent: parentOf(env.project, location),
            gatewaySecurityPolicyId,
            body: {
              description: desiredDescription,
              tlsInspectionPolicy,
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
      const tlsChanged =
        canonicalizeLink(current.tlsInspectionPolicy) !==
        (tlsInspectionPolicy ?? "");
      const updateMask = changedFields([
        ["description", descriptionChanged],
        ["tlsInspectionPolicy", tlsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networksecurity.patchProjectsLocationsGatewaySecurityPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
              tlsInspectionPolicy,
            },
          });
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
        .deleteProjectsLocationsGatewaySecurityPolicies({ name: output.name })
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
