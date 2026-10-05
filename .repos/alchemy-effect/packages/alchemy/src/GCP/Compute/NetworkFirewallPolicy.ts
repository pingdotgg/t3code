import { ignoredCodes } from "./internal.ts";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
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

const DEFAULT_POLICY_TYPE = "VPC_POLICY";
const RESERVED_PRIORITY_MIN = 2147483548;
const RESERVED_PRIORITY_MAX = 2147483647;
const MAX_NAME_LENGTH = 63;

const isReservedPriority = (priority: number | undefined) =>
  priority !== undefined &&
  priority >= RESERVED_PRIORITY_MIN &&
  priority <= RESERVED_PRIORITY_MAX;

export type NetworkFirewallPolicyType =
  | compute.FirewallPolicyPolicyTypeEnum
  | (string & {});
export type NetworkFirewallPolicyRule = compute.FirewallPolicyRule;
export type NetworkFirewallPolicyRuleMatcher =
  compute.FirewallPolicyRuleMatcher;
export type NetworkFirewallPolicyAssociation =
  compute.FirewallPolicyAssociation;

export type NetworkFirewallPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the policy.
   */
  networkFirewallPolicyName?: string;
  /**
   * Optional description. Network firewall policies have no labels field,
   * so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   * Updated in place via `patch`.
   */
  description?: string;
  /**
   * Policy type. Set only at create time — changing it replaces the
   * policy.
   * @default "VPC_POLICY"
   */
  policyType?: NetworkFirewallPolicyType;
  /**
   * Hierarchical firewall rules. GCP always keeps default `goto_next`
   * rules in the reserved priority range `2147483548`–`2147483647`;
   * Alchemy never add/patch/remove those. When this field is set, user
   * rules are synced with `addRule` / `patchRule` / `removeRule`. When
   * omitted on later updates, observed rules are left in place.
   */
  rules?: NetworkFirewallPolicyRule[];
  /**
   * VPC associations. When set, Alchemy syncs associations with
   * `addAssociation` / `removeAssociation`. `attachmentTarget` accepts a
   * network name or URL. When omitted on later updates, observed
   * associations are left in place.
   */
  associations?: NetworkFirewallPolicyAssociation[];
};

export type NetworkFirewallPolicy = Resource<
  "GCP.Compute.NetworkFirewallPolicy",
  NetworkFirewallPolicyProps,
  {
    /** Policy name. */
    networkFirewallPolicyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Policy type. */
    policyType: string;
    /** Rules currently attached (including the default). */
    rules: NetworkFirewallPolicyRule[];
    /** Associations currently attached. */
    associations: NetworkFirewallPolicyAssociation[];
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-assigned numeric id. */
    networkFirewallPolicyId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Self-link including the numeric id. */
    selfLinkWithId: string | undefined;
    /** Total count of rule tuples. */
    ruleTupleCount: number | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine network firewall policy.
 *
 * Network firewall policies live at the project level under
 * `global/firewallPolicies` and are identified by the user-provided
 * `name`. Name and policy type are immutable. Description updates in
 * place via `networkFirewallPolicies.patch`. Rules are synced with
 * `addRule` / `patchRule` / `removeRule`. Associations are synced with
 * `addAssociation` / `removeAssociation`. Compute network firewall
 * policies have no labels field — Alchemy stamps ownership into the
 * description so nuke can find leaked policies.
 *
 * ### Creating a Network Firewall Policy
 * **Example:** Generated name with an allow rule
 * ```typescript
 * const policy = yield* GCP.Compute.NetworkFirewallPolicy("VpcFw", {
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
 * **Example:** Associate with a VPC
 * ```typescript
 * const policy = yield* GCP.Compute.NetworkFirewallPolicy("VpcFw", {
 *   networkFirewallPolicyName: "app-nfw",
 *   associations: [{ name: "vpc", attachmentTarget: network.selfLink }],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const NetworkFirewallPolicy = Resource<NetworkFirewallPolicy>(
  "GCP.Compute.NetworkFirewallPolicy",
);

export class NetworkFirewallPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.NetworkFirewallPolicyNotResolved",
)<{
  networkFirewallPolicyName: string;
}> {}

export class NetworkFirewallPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.NetworkFirewallPolicyStillExists",
)<{
  networkFirewallPolicyName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
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
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const networkUrl = (project: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/global/networks/${value}`;
};

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const canonMatch = (match: NetworkFirewallPolicyRuleMatcher | undefined) => {
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
    srcSecureTags: [...(match.srcSecureTags ?? [])]
      .map((tag) => tag.name ?? "")
      .sort(),
  };
};

const canonRule = (rule: NetworkFirewallPolicyRule) => ({
  priority: rule.priority,
  action: rule.action,
  description: rule.description ?? "",
  direction: (rule.direction ?? "INGRESS").toUpperCase(),
  enableLogging: rule.enableLogging === true,
  disabled: rule.disabled === true,
  ruleName: rule.ruleName ?? "",
  tlsInspect: rule.tlsInspect === true,
  targetType: rule.targetType ?? "INSTANCES",
  securityProfileGroup: rule.securityProfileGroup ?? "",
  match: canonMatch(rule.match),
  targetResources: sorted(rule.targetResources),
  targetServiceAccounts: sorted(rule.targetServiceAccounts),
  targetForwardingRules: sorted(rule.targetForwardingRules),
  targetSecureTags: [...(rule.targetSecureTags ?? [])]
    .map((tag) => tag.name ?? "")
    .sort(),
});

const ruleEquals = (
  left: NetworkFirewallPolicyRule,
  right: NetworkFirewallPolicyRule,
) => sameJson(canonRule(left), canonRule(right));

const toRuleBody = (
  rule: NetworkFirewallPolicyRule,
): NetworkFirewallPolicyRule => ({
  priority: rule.priority,
  action: rule.action,
  description: rule.description,
  direction: rule.direction,
  enableLogging: rule.enableLogging === true ? true : undefined,
  disabled: rule.disabled === true ? true : undefined,
  ruleName: rule.ruleName,
  tlsInspect: rule.tlsInspect === true ? true : undefined,
  targetType: rule.targetType,
  securityProfileGroup: rule.securityProfileGroup,
  match: rule.match,
  targetResources: rule.targetResources,
  targetServiceAccounts: rule.targetServiceAccounts,
  targetForwardingRules: rule.targetForwardingRules,
  targetSecureTags: rule.targetSecureTags,
});

const desiredRules = (
  news: NetworkFirewallPolicyProps,
): NetworkFirewallPolicyRule[] | undefined => {
  if (news.rules === undefined) return undefined;
  const byPriority = new Map<number, NetworkFirewallPolicyRule>();
  for (const rule of news.rules) {
    if (rule.priority === undefined) continue;
    if (isReservedPriority(rule.priority)) continue;
    byPriority.set(rule.priority, rule);
  }
  return [...byPriority.values()].sort(
    (left, right) => (left.priority ?? 0) - (right.priority ?? 0),
  );
};

const associationNameOf = (
  association: NetworkFirewallPolicyAssociation,
): string =>
  association.name && association.name.length > 0
    ? association.name
    : lastSegment(association.attachmentTarget) || "assoc";

const toAttrs = (
  policy: compute.FirewallPolicy,
  project: string,
): NetworkFirewallPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    networkFirewallPolicyName: policy.name ?? "",
    project,
    description: parsed.description,
    policyType: typeOf(policy.policyType),
    rules: policy.rules ?? [],
    associations: policy.associations ?? [],
    fingerprint: policy.fingerprint,
    networkFirewallPolicyId: policy.id,
    selfLink: policy.selfLink,
    selfLinkWithId: policy.selfLinkWithId,
    ruleTupleCount: policy.ruleTupleCount,
    creationTimestamp: policy.creationTimestamp,
    kind: policy.kind,
  };
};

const getByName = (project: string, firewallPolicy: string) =>
  compute
    .getNetworkFirewallPolicies({ project, firewallPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, networkFirewallPolicyName: string) =>
  getByName(project, networkFirewallPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(
            new NetworkFirewallPolicyNotResolved({
              networkFirewallPolicyName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkFirewallPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, networkFirewallPolicyName: string) =>
  getByName(project, networkFirewallPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(
            new NetworkFirewallPolicyStillExists({
              networkFirewallPolicyName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkFirewallPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.NetworkFirewallPolicyStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  networkFirewallPolicyName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitGlobalOperation(project, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const syncRules = (
  project: string,
  networkFirewallPolicyName: string,
  observed: readonly NetworkFirewallPolicyRule[],
  desired: readonly NetworkFirewallPolicyRule[],
) =>
  Effect.gen(function* () {
    const observedByPriority = new Map<number, NetworkFirewallPolicyRule>();
    for (const rule of observed) {
      if (rule.priority !== undefined) {
        observedByPriority.set(rule.priority, rule);
      }
    }
    const desiredByPriority = new Map<number, NetworkFirewallPolicyRule>();
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
          networkFirewallPolicyName,
          compute.addRuleNetworkFirewallPolicies({
            project,
            firewallPolicy: networkFirewallPolicyName,
            body: toRuleBody(rule),
          }),
          { ignoreAlreadyExists: true },
        );
        continue;
      }
      if (!ruleEquals(current, rule)) {
        yield* runOp(
          project,
          networkFirewallPolicyName,
          compute.patchRuleNetworkFirewallPolicies({
            project,
            firewallPolicy: networkFirewallPolicyName,
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
        networkFirewallPolicyName,
        compute.removeRuleNetworkFirewallPolicies({
          project,
          firewallPolicy: networkFirewallPolicyName,
          priority,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

const syncAssociations = (
  project: string,
  networkFirewallPolicyName: string,
  observed: readonly NetworkFirewallPolicyAssociation[],
  desired: readonly NetworkFirewallPolicyAssociation[],
) =>
  Effect.gen(function* () {
    const observedByName = new Map<string, NetworkFirewallPolicyAssociation>();
    for (const association of observed) {
      observedByName.set(associationNameOf(association), association);
    }
    const desiredByName = new Map<string, NetworkFirewallPolicyAssociation>();
    for (const association of desired) {
      desiredByName.set(associationNameOf(association), association);
    }

    for (const [name, association] of desiredByName) {
      const current = observedByName.get(name);
      const target = association.attachmentTarget
        ? networkUrl(project, association.attachmentTarget)
        : undefined;
      if (current === undefined) {
        yield* runOp(
          project,
          networkFirewallPolicyName,
          compute.addAssociationNetworkFirewallPolicies({
            project,
            firewallPolicy: networkFirewallPolicyName,
            body: { name, attachmentTarget: target },
          }),
          { ignoreAlreadyExists: true },
        );
        continue;
      }
      if (
        lastSegment(current.attachmentTarget) !== lastSegment(target) &&
        target !== undefined
      ) {
        yield* runOp(
          project,
          networkFirewallPolicyName,
          compute.addAssociationNetworkFirewallPolicies({
            project,
            firewallPolicy: networkFirewallPolicyName,
            replaceExistingAssociation: true,
            body: { name, attachmentTarget: target },
          }),
        );
      }
    }

    for (const name of observedByName.keys()) {
      if (desiredByName.has(name)) continue;
      yield* runOp(
        project,
        networkFirewallPolicyName,
        compute.removeAssociationNetworkFirewallPolicies({
          project,
          firewallPolicy: networkFirewallPolicyName,
          name,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

export const NetworkFirewallPolicyProvider = () =>
  Provider.succeed(NetworkFirewallPolicy, {
    stables: [
      "networkFirewallPolicyName",
      "project",
      "networkFirewallPolicyId",
      "policyType",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // Name is immutable on GCP. Resolve the desired name the same way
      // create does — do not fall back to previousName when news omits
      // networkFirewallPolicyName, or a generated-name change looks like a no-op.
      const previousName =
        output?.networkFirewallPolicyName ?? olds?.networkFirewallPolicyName;
      const nextName = yield* toName(id, news.networkFirewallPolicyName);
      const nameChanged =
        previousName !== undefined && previousName !== nextName;
      const previousType = typeOf(olds?.policyType ?? output?.policyType);
      const nextType = typeOf(news.policyType ?? previousType);
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkFirewallPolicyName = yield* toName(
        id,
        olds?.networkFirewallPolicyName,
        output?.networkFirewallPolicyName,
      );
      const existing = yield* getByName(env.project, networkFirewallPolicyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listNetworkFirewallPolicies
          .items({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((policy) => hasOwnershipMarker(policy.description)),
            Stream.map((policy) => toAttrs(policy, env.project)),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as NetworkFirewallPolicy["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkFirewallPolicyName = yield* toName(
        id,
        news.networkFirewallPolicyName,
        output?.networkFirewallPolicyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const policyType = typeOf(news.policyType);

      let current = yield* getByName(env.project, networkFirewallPolicyName);

      if (current === undefined) {
        yield* compute
          .insertNetworkFirewallPolicies({
            project: env.project,
            body: {
              name: networkFirewallPolicyName,
              description: desiredDescription,
              policyType,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, networkFirewallPolicyName);
      }

      if ((current.description ?? "") !== desiredDescription) {
        yield* runOp(
          env.project,
          networkFirewallPolicyName,
          compute.patchNetworkFirewallPolicies({
            project: env.project,
            firewallPolicy: networkFirewallPolicyName,
            body: {
              description: desiredDescription,
              fingerprint: current.fingerprint,
            },
          }),
        );
        current =
          (yield* getByName(env.project, networkFirewallPolicyName)) ?? current;
      }

      const nextRules = desiredRules(news);
      if (nextRules !== undefined) {
        yield* syncRules(
          env.project,
          networkFirewallPolicyName,
          current.rules ?? [],
          nextRules,
        );
        current =
          (yield* getByName(env.project, networkFirewallPolicyName)) ?? current;
      }

      if (news.associations !== undefined) {
        yield* syncAssociations(
          env.project,
          networkFirewallPolicyName,
          current.associations ?? [],
          news.associations,
        );
        current =
          (yield* getByName(env.project, networkFirewallPolicyName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.networkFirewallPolicyName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const existing = yield* getByName(
        project,
        output.networkFirewallPolicyName,
      );
      for (const association of existing?.associations ?? []) {
        const name = associationNameOf(association);
        yield* compute
          .removeAssociationNetworkFirewallPolicies({
            project,
            firewallPolicy: output.networkFirewallPolicyName,
            name,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(project, operation, {
                ignore: ["RESOURCE_NOT_FOUND"],
              }),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }
      yield* compute
        .deleteNetworkFirewallPolicies({
          project,
          firewallPolicy: output.networkFirewallPolicyName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(project, operation, {
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
      yield* waitUntilGone(project, output.networkFirewallPolicyName);
    }),
  });
