import { ignoredCodes } from "./internal.ts";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type {
  FirewallPolicyAssociation,
  FirewallPolicyRule,
  FirewallPolicyRuleMatcher,
  FirewallPolicyType,
} from "./FirewallPolicy.ts";

const DEFAULT_POLICY_TYPE = "VPC_POLICY";
const RESERVED_PRIORITY_MIN = 2147483548;
const RESERVED_PRIORITY_MAX = 2147483647;
const MAX_NAME_LENGTH = 63;

const isReservedPriority = (priority: number | undefined) =>
  priority !== undefined &&
  priority >= RESERVED_PRIORITY_MIN &&
  priority <= RESERVED_PRIORITY_MAX;

export type RegionNetworkFirewallPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the policy.
   */
  firewallPolicyName?: string;
  /**
   * Region the policy lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Network firewall policies have no labels field,
   * so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Policy type. Set only at create time — changing it replaces the
   * policy.
   * @default "VPC_POLICY"
   */
  policyType?: FirewallPolicyType;
  /**
   * Network firewall rules. GCP always keeps default `goto_next` rules
   * in the reserved priority range `2147483548`–`2147483647`; Alchemy
   * never add/patch/remove those. When this field is set, user rules
   * are synced with `addRule` / `patchRule` / `removeRule` (not
   * `patch`). When omitted on later updates, observed rules are left
   * in place.
   */
  rules?: FirewallPolicyRule[];
};

export type RegionNetworkFirewallPolicy = Resource<
  "GCP.Compute.RegionNetworkFirewallPolicy",
  RegionNetworkFirewallPolicyProps,
  {
    /** User-provided RFC1035 name. */
    firewallPolicyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Policy type (`VPC_POLICY`, `RDMA_ROCE_POLICY`, `ULL_POLICY`). */
    policyType: string;
    /** Rules currently attached (including the default). */
    rules: FirewallPolicyRule[];
    /** Associations currently attached to this policy. */
    associations: FirewallPolicyAssociation[];
    /** Optimistic-locking fingerprint for metadata patches. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the numeric id. */
    selfLinkWithId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Total count of rule tuples. */
    ruleTupleCount: number | undefined;
    /** Server-assigned numeric id. */
    firewallPolicyId: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional network firewall policy attached to a VPC network.
 *
 * Policies live under `projects/{project}/regions/{region}/firewallPolicies`
 * and are identified by a user-provided RFC1035 name. Name, region, and
 * `policyType` are immutable — changing any of them replaces the policy.
 * Description updates in place via `regionNetworkFirewallPolicies.patch`.
 * Rules are synced with `addRule` / `patchRule` / `removeRule`.
 *
 * Compute Engine network firewall policies have no resource labels.
 * Alchemy stamps ownership into the description so `read` / `list` (and
 * `pnpm nuke:gcp`) can find them.
 *
 * ### Creating a Regional Network Firewall Policy
 * **Example:** Generated name with an allow rule
 * ```typescript
 * const policy = yield* GCP.Compute.RegionNetworkFirewallPolicy("VpcFw", {
 *   region: "us-central1",
 *   description: "allow internal http",
 *   rules: [
 *     {
 *       action: "allow",
 *       priority: 1000,
 *       direction: "INGRESS",
 *       match: {
 *         srcIpRanges: ["10.0.0.0/8"],
 *         layer4Configs: [{ ipProtocol: "tcp", ports: ["80"] }],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionNetworkFirewallPolicy =
  Resource<RegionNetworkFirewallPolicy>(
    "GCP.Compute.RegionNetworkFirewallPolicy",
  );

export class RegionNetworkFirewallPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionNetworkFirewallPolicyNotResolved",
)<{
  firewallPolicyName: string;
  region: string;
}> {}

export class RegionNetworkFirewallPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.RegionNetworkFirewallPolicyStillExists",
)<{
  firewallPolicyName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `f${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "policy";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return rfc1035(name);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_POLICY_TYPE).toUpperCase();

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const canonMatch = (match: FirewallPolicyRuleMatcher | undefined) => {
  if (match === undefined) return undefined;
  return {
    srcIpRanges: sorted(match.srcIpRanges),
    destIpRanges: sorted(match.destIpRanges),
    srcFqdns: sorted(match.srcFqdns),
    destFqdns: sorted(match.destFqdns),
    srcRegionCodes: sorted(match.srcRegionCodes),
    destRegionCodes: sorted(match.destRegionCodes),
    srcAddressGroups: sorted(match.srcAddressGroups),
    destAddressGroups: sorted(match.destAddressGroups),
    srcThreatIntelligences: sorted(match.srcThreatIntelligences),
    destThreatIntelligences: sorted(match.destThreatIntelligences),
    srcNetworks: sorted(match.srcNetworks),
    srcNetworkType: match.srcNetworkType,
    destNetworkType: match.destNetworkType,
    layer4Configs: [...(match.layer4Configs ?? [])]
      .map((config) => ({
        ipProtocol: (config.ipProtocol ?? "").toLowerCase(),
        ports: sorted(config.ports),
      }))
      .sort(
        (left, right) =>
          left.ipProtocol.localeCompare(right.ipProtocol) ||
          JSON.stringify(left.ports).localeCompare(JSON.stringify(right.ports)),
      ),
  };
};

const canonRule = (rule: FirewallPolicyRule) => ({
  priority: rule.priority,
  action: rule.action,
  description: rule.description ?? "",
  direction: (rule.direction ?? "INGRESS").toUpperCase(),
  enableLogging: rule.enableLogging === true,
  disabled: rule.disabled === true,
  ruleName: rule.ruleName ?? "",
  match: canonMatch(rule.match),
  targetResources: sorted(rule.targetResources),
  targetServiceAccounts: sorted(rule.targetServiceAccounts),
});

const ruleEquals = (left: FirewallPolicyRule, right: FirewallPolicyRule) =>
  sameJson(canonRule(left), canonRule(right));

const toRuleBody = (rule: FirewallPolicyRule): FirewallPolicyRule => ({
  priority: rule.priority,
  action: rule.action,
  description: rule.description,
  direction: rule.direction,
  enableLogging: rule.enableLogging === true ? true : undefined,
  disabled: rule.disabled === true ? true : undefined,
  ruleName: rule.ruleName,
  match: rule.match,
  targetResources: rule.targetResources,
  targetServiceAccounts: rule.targetServiceAccounts,
  targetSecureTags: rule.targetSecureTags,
});

const desiredRules = (
  news: RegionNetworkFirewallPolicyProps,
): FirewallPolicyRule[] | undefined => {
  if (news.rules === undefined) return undefined;
  const byPriority = new Map<number, FirewallPolicyRule>();
  for (const rule of news.rules) {
    if (rule.priority === undefined) continue;
    if (isReservedPriority(rule.priority)) continue;
    byPriority.set(rule.priority, rule);
  }
  return [...byPriority.values()].sort(
    (left, right) => (left.priority ?? 0) - (right.priority ?? 0),
  );
};

const toAttrs = (
  policy: compute.FirewallPolicy,
  project: string,
): RegionNetworkFirewallPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    firewallPolicyName: policy.name ?? policy.id ?? "",
    project,
    region: lastSegment(policy.region).toLowerCase(),
    description: parsed.description,
    policyType: typeOf(policy.policyType),
    rules: policy.rules ?? [],
    associations: policy.associations ?? [],
    fingerprint: policy.fingerprint,
    selfLink: policy.selfLink,
    selfLinkWithId: policy.selfLinkWithId,
    creationTimestamp: policy.creationTimestamp,
    ruleTupleCount: policy.ruleTupleCount,
    firewallPolicyId: policy.id,
    kind: policy.kind,
  };
};

const getByName = (project: string, region: string, firewallPolicy: string) =>
  compute
    .getRegionNetworkFirewallPolicies({ project, region, firewallPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  firewallPolicyName: string,
) =>
  getByName(project, region, firewallPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(
            new RegionNetworkFirewallPolicyNotResolved({
              firewallPolicyName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionNetworkFirewallPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  firewallPolicyName: string,
) =>
  getByName(project, region, firewallPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(
            new RegionNetworkFirewallPolicyStillExists({
              firewallPolicyName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionNetworkFirewallPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.RegionNetworkFirewallPolicyStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  firewallPolicyName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitRegionOperation(project, region, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const insertBody = (
  firewallPolicyName: string,
  news: RegionNetworkFirewallPolicyProps,
  description: string,
): compute.FirewallPolicy => ({
  name: firewallPolicyName,
  description,
  policyType: typeOf(news.policyType),
});

const syncRules = (
  project: string,
  region: string,
  firewallPolicyName: string,
  observed: readonly FirewallPolicyRule[],
  desired: readonly FirewallPolicyRule[],
) =>
  Effect.gen(function* () {
    const observedByPriority = new Map<number, FirewallPolicyRule>();
    for (const rule of observed) {
      if (rule.priority !== undefined) {
        observedByPriority.set(rule.priority, rule);
      }
    }
    const desiredByPriority = new Map<number, FirewallPolicyRule>();
    for (const rule of desired) {
      if (rule.priority !== undefined) {
        desiredByPriority.set(rule.priority, rule);
      }
    }

    for (const [priority, rule] of desiredByPriority) {
      if (isReservedPriority(priority)) continue;
      const current = observedByPriority.get(priority);
      if (current === undefined) {
        yield* runOp(
          project,
          region,
          firewallPolicyName,
          compute.addRuleRegionNetworkFirewallPolicies({
            project,
            region,
            firewallPolicy: firewallPolicyName,
            body: toRuleBody(rule),
          }),
          { ignoreAlreadyExists: true },
        );
        continue;
      }
      if (!ruleEquals(current, rule)) {
        yield* runOp(
          project,
          region,
          firewallPolicyName,
          compute.patchRuleRegionNetworkFirewallPolicies({
            project,
            region,
            firewallPolicy: firewallPolicyName,
            priority,
            body: toRuleBody(rule),
          }),
        );
      }
    }

    for (const priority of observedByPriority.keys()) {
      if (desiredByPriority.has(priority)) continue;
      if (isReservedPriority(priority)) continue;
      yield* runOp(
        project,
        region,
        firewallPolicyName,
        compute.removeRuleRegionNetworkFirewallPolicies({
          project,
          region,
          firewallPolicy: firewallPolicyName,
          priority,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

export const RegionNetworkFirewallPolicyProvider = () =>
  Provider.succeed(RegionNetworkFirewallPolicy, {
    stables: [
      "firewallPolicyName",
      "project",
      "region",
      "policyType",
      "firewallPolicyId",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      // Name is immutable on GCP. Resolve the desired name the same way
      // create does — do not fall back to previousName when news omits
      // firewallPolicyName, or a generated-name change looks like a no-op.
      const previousName =
        output?.firewallPolicyName ?? olds?.firewallPolicyName;
      const nextName = yield* toName(id, news.firewallPolicyName);
      const nameChanged =
        previousName !== undefined && previousName !== nextName;

      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      const previousType = typeOf(olds?.policyType ?? output?.policyType);
      const nextType = typeOf(news.policyType ?? output?.policyType);
      const typeChanged = previousType !== nextType;

      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (regionChanged || typeChanged) {
        return { action: "replace" as const, deleteFirst: !regionChanged };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallPolicyName = yield* toName(
        id,
        olds?.firewallPolicyName,
        output?.firewallPolicyName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        firewallPolicyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNetworkFirewallPolicies
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.firewallPolicies ?? [])
              .filter((policy) => (policy.region ?? "").length > 0)
              .filter((policy) => hasOwnershipMarker(policy.description))
              .map((policy) => toAttrs(policy, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallPolicyName = yield* toName(
        id,
        news.firewallPolicyName,
        output?.firewallPolicyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, region, firewallPolicyName);

      if (current === undefined) {
        yield* compute
          .insertRegionNetworkFirewallPolicies({
            project: env.project,
            region,
            body: insertBody(firewallPolicyName, news, desiredDescription),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, region, firewallPolicyName);
      }

      if (current === undefined) {
        return yield* new RegionNetworkFirewallPolicyNotResolved({
          firewallPolicyName,
          region,
        });
      }

      if ((current.description ?? "") !== desiredDescription) {
        yield* runOp(
          env.project,
          region,
          firewallPolicyName,
          compute.patchRegionNetworkFirewallPolicies({
            project: env.project,
            region,
            firewallPolicy: firewallPolicyName,
            body: {
              fingerprint: current.fingerprint,
              description: desiredDescription,
            },
          }),
        );
        current =
          (yield* getByName(env.project, region, firewallPolicyName)) ??
          current;
      }

      const nextRules = desiredRules(news);
      if (nextRules !== undefined) {
        yield* syncRules(
          env.project,
          region,
          firewallPolicyName,
          current.rules ?? [],
          nextRules,
        );
        current =
          (yield* getByName(env.project, region, firewallPolicyName)) ??
          current;
      }

      if (current === undefined) {
        return yield* new RegionNetworkFirewallPolicyNotResolved({
          firewallPolicyName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteRegionNetworkFirewallPolicies({
          project,
          region,
          firewallPolicy: output.firewallPolicyName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.firewallPolicyName);
    }),
  });
