import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { ignoredCodes } from "./internal.ts";
import { waitOrganizationOperation } from "./operations.ts";
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
const DEFAULT_RULE_PRIORITY = 2147483647;
const MAX_NAME_LENGTH = 63;

export type FirewallPolicyType =
  | compute.FirewallPolicyPolicyTypeEnum
  | (string & {});
export type FirewallPolicyRule = compute.FirewallPolicyRule;
export type FirewallPolicyRuleMatcher = compute.FirewallPolicyRuleMatcher;
export type FirewallPolicyAssociation = compute.FirewallPolicyAssociation;

export type FirewallPolicyProps = {
  /**
   * User-provided RFC1035 name (`shortName`). Unique within the parent
   * organization or folder. If omitted, a unique name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the policy. After create, GCP also assigns a numeric `name`.
   */
  shortName?: string;
  /**
   * Parent folder or organization. Format `folders/{folder}` or
   * `organizations/{organization}`. If omitted, Alchemy uses the project
   * parent from Cloud Resource Manager. Immutable — changing it replaces
   * the policy.
   */
  parent?: string;
  /**
   * Optional description. Hierarchical firewall policies have no labels
   * field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
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
   * Hierarchical firewall rules. GCP always keeps a default rule at
   * priority `2147483647` matching all traffic (`goto_next` if you do
   * not supply one). When this field is set, Alchemy syncs rules with
   * `addRule` / `patchRule` / `removeRule` (not `patch`). When omitted
   * on later updates, observed rules are left in place.
   */
  rules?: FirewallPolicyRule[];
};

export type FirewallPolicy = Resource<
  "GCP.Compute.FirewallPolicy",
  FirewallPolicyProps,
  {
    /** User-provided RFC1035 name. */
    shortName: string;
    /** Server-assigned numeric policy id (`name` in the API). */
    firewallPolicyId: string;
    /** Parent `folders/{folder}` or `organizations/{organization}`. */
    parent: string;
    /** Project id of the deploying stack (policies are org/folder scoped). */
    project: string;
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
    /** Server-assigned numeric id (same as `firewallPolicyId` when present). */
    id: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A hierarchical firewall policy attached to an organization or folder.
 *
 * Policies live under `locations/global/firewallPolicies` and are
 * identified by a server-assigned numeric id. The user-facing name is
 * `shortName`. Parent and `shortName` are immutable — changing either
 * replaces the policy. Description updates in place via
 * `firewallPolicies.patch`. Rules are synced with `addRule` /
 * `patchRule` / `removeRule`.
 *
 * Compute Engine firewall policies have no resource labels. Alchemy
 * stamps ownership into the description so `read` / `list` (and
 * `pnpm nuke:gcp`) can find them.
 *
 * ### Creating a Firewall Policy
 * **Example:** Generated name with an allow rule
 * ```typescript
 * const policy = yield* GCP.Compute.FirewallPolicy("OrgFw", {
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
 * **Example:** Named policy under a folder
 * ```typescript
 * const policy = yield* GCP.Compute.FirewallPolicy("OrgFw", {
 *   shortName: "app-org-fw",
 *   parent: "folders/123456789",
 *   description: "folder guardrail",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const FirewallPolicy = Resource<FirewallPolicy>(
  "GCP.Compute.FirewallPolicy",
);

export class FirewallPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.FirewallPolicyNotResolved",
)<{
  firewallPolicyId: string;
  shortName: string;
}> {}

export class FirewallPolicyParentRequired extends Data.TaggedError(
  "GCP.Compute.FirewallPolicyParentRequired",
)<{
  project: string;
}> {}

export class FirewallPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.FirewallPolicyStillExists",
)<{
  firewallPolicyId: string;
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
  if (!/^[a-z]/.test(next)) {
    next = `f${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "policy";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const normalizeParent = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("organizations/") || trimmed.startsWith("folders/")) {
    return trimmed;
  }
  if (trimmed.startsWith("organization/")) {
    return `organizations/${trimmed.slice("organization/".length)}`;
  }
  if (trimmed.startsWith("folder/")) {
    return `folders/${trimmed.slice("folder/".length)}`;
  }
  if (/^\d+$/.test(trimmed)) return `organizations/${trimmed}`;
  return trimmed;
};

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

const projectParent = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) =>
      resource.parent !== undefined && resource.parent.length > 0
        ? normalizeParent(resource.parent)
        : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const resolveParent = (
  news: FirewallPolicyProps,
  output: { parent?: string } | undefined,
) =>
  Effect.gen(function* () {
    const explicit = news.parent ?? output?.parent;
    if (explicit !== undefined && explicit.length > 0) {
      return normalizeParent(explicit);
    }
    const env = yield* GcpEnvironment.current;
    const fromProject = yield* projectParent(env.project);
    if (fromProject !== undefined) return fromProject;
    return yield* new FirewallPolicyParentRequired({ project: env.project });
  });

const listParents = (project: string) =>
  Effect.gen(function* () {
    const parents = new Set<string>();
    const fromProject = yield* projectParent(project);
    if (fromProject !== undefined) parents.add(fromProject);
    return [...parents];
  });

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
    srcNetworkContext: match.srcNetworkContext,
    destNetworkContext: match.destNetworkContext,
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

const canonRule = (rule: FirewallPolicyRule) => ({
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
  news: FirewallPolicyProps,
  observed: readonly FirewallPolicyRule[],
): FirewallPolicyRule[] | undefined => {
  if (news.rules === undefined) return undefined;
  const byPriority = new Map<number, FirewallPolicyRule>();
  for (const rule of news.rules) {
    if (rule.priority === undefined) continue;
    byPriority.set(rule.priority, rule);
  }
  if (!byPriority.has(DEFAULT_RULE_PRIORITY)) {
    const observedDefault = observed.find(
      (rule) => rule.priority === DEFAULT_RULE_PRIORITY,
    );
    if (observedDefault !== undefined) {
      byPriority.set(DEFAULT_RULE_PRIORITY, observedDefault);
    }
  }
  return [...byPriority.values()].sort(
    (left, right) => (left.priority ?? 0) - (right.priority ?? 0),
  );
};

const policyIdOf = (policy: compute.FirewallPolicy) =>
  policy.name ?? policy.id ?? lastSegment(policy.selfLinkWithId);

const toAttrs = (
  policy: compute.FirewallPolicy,
  project: string,
): FirewallPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    shortName: policy.shortName ?? policy.displayName ?? "",
    firewallPolicyId: policyIdOf(policy),
    parent: policy.parent ?? "",
    project,
    description: parsed.description,
    policyType: typeOf(policy.policyType),
    rules: policy.rules ?? [],
    associations: policy.associations ?? [],
    fingerprint: policy.fingerprint,
    selfLink: policy.selfLink,
    selfLinkWithId: policy.selfLinkWithId,
    creationTimestamp: policy.creationTimestamp,
    ruleTupleCount: policy.ruleTupleCount,
    id: policy.id,
    kind: policy.kind,
  };
};

const getById = (firewallPolicy: string) =>
  compute
    .getFirewallPolicies({ firewallPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findByShortName = (parentId: string, shortName: string) =>
  compute.listFirewallPolicies
    .items({
      parentId,
      maxResults: 500,
      returnPartialSuccess: true,
    })
    .pipe(
      Stream.filter((policy) => policy.shortName === shortName),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const observe = (
  firewallPolicyId: string | undefined,
  parentId: string,
  shortName: string,
) =>
  Effect.gen(function* () {
    if (firewallPolicyId !== undefined && firewallPolicyId.length > 0) {
      const existing = yield* getById(firewallPolicyId);
      if (existing !== undefined) return existing;
    }
    return yield* findByShortName(parentId, shortName);
  });

const awaitResource = (
  firewallPolicyId: string,
  parentId: string,
  shortName: string,
) =>
  observe(firewallPolicyId, parentId, shortName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(
            new FirewallPolicyNotResolved({ firewallPolicyId, shortName }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.FirewallPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (firewallPolicyId: string) =>
  getById(firewallPolicyId).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new FirewallPolicyStillExists({ firewallPolicyId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.FirewallPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.Compute.FirewallPolicyStillExists", () => Effect.void),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  firewallPolicyId: string,
  parentId: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitOrganizationOperation(operation, parentId, {
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
  shortName: string,
  news: FirewallPolicyProps,
  description: string,
): compute.FirewallPolicy => ({
  shortName,
  description,
  policyType: typeOf(news.policyType),
  rules: news.rules !== undefined ? news.rules.map(toRuleBody) : undefined,
});

const idFromOperation = (operation: compute.Operation) => {
  if (operation.targetId !== undefined && operation.targetId.length > 0) {
    return operation.targetId;
  }
  const fromLink = lastSegment(operation.targetLink);
  return fromLink.length > 0 ? fromLink : "";
};

const syncRules = (
  firewallPolicyId: string,
  parentId: string,
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
      const current = observedByPriority.get(priority);
      if (current === undefined) {
        yield* runOp(
          firewallPolicyId,
          parentId,
          compute.addRuleFirewallPolicies({
            firewallPolicy: firewallPolicyId,
            body: toRuleBody(rule),
          }),
          { ignoreAlreadyExists: true },
        );
        continue;
      }
      if (!ruleEquals(current, rule)) {
        yield* runOp(
          firewallPolicyId,
          parentId,
          compute.patchRuleFirewallPolicies({
            firewallPolicy: firewallPolicyId,
            priority,
            body: toRuleBody(rule),
          }),
        );
      }
    }

    for (const priority of observedByPriority.keys()) {
      if (desiredByPriority.has(priority)) continue;
      if (priority === DEFAULT_RULE_PRIORITY) continue;
      yield* runOp(
        firewallPolicyId,
        parentId,
        compute.removeRuleFirewallPolicies({
          firewallPolicy: firewallPolicyId,
          priority,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

export const FirewallPolicyProvider = () =>
  Provider.succeed(FirewallPolicy, {
    stables: [
      "shortName",
      "firewallPolicyId",
      "parent",
      "project",
      "policyType",
      "id",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName = olds?.shortName ?? output?.shortName;
      const nextName = news.shortName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousParent = olds?.parent ?? output?.parent;
      const nextParent =
        news.parent !== undefined
          ? normalizeParent(news.parent)
          : previousParent;
      const parentChanged =
        previousParent !== undefined &&
        nextParent !== undefined &&
        normalizeParent(previousParent) !== normalizeParent(nextParent);

      const previousType = typeOf(olds?.policyType ?? output?.policyType);
      const nextType = typeOf(news.policyType ?? output?.policyType);
      const typeChanged = previousType !== nextType;

      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (parentChanged || typeChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const shortName = yield* toName(id, olds?.shortName, output?.shortName);
      const parent = yield* resolveParent(olds ?? {}, output).pipe(
        Effect.catchTag("GCP.Compute.FirewallPolicyParentRequired", () =>
          Effect.succeed(output?.parent ?? olds?.parent ?? ""),
        ),
      );
      const existing = yield* observe(
        output?.firewallPolicyId,
        parent,
        shortName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listParents(env.project);
        if (parents.length === 0) return [];
        const listed: FirewallPolicy["Attributes"][] = [];
        for (const parentId of parents) {
          const chunk = yield* compute.listFirewallPolicies
            .items({
              parentId,
              maxResults: 500,
              returnPartialSuccess: true,
            })
            .pipe(
              Stream.filter((policy) => hasOwnershipMarker(policy.description)),
              Stream.map((policy) => toAttrs(policy, env.project)),
              Stream.runCollect,
              Effect.map((items) => Array.from(items)),
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as FirewallPolicy["Attributes"][]),
              ),
            );
          listed.push(...chunk);
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const shortName = yield* toName(id, news.shortName, output?.shortName);
      const parentId = yield* resolveParent(news, output);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* observe(
        output?.firewallPolicyId,
        parentId,
        shortName,
      );

      if (current === undefined) {
        const inserted = yield* compute
          .insertFirewallPolicies({
            parentId,
            body: insertBody(shortName, news, desiredDescription),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitOrganizationOperation(operation, parentId, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        const createdId =
          inserted !== undefined ? idFromOperation(inserted) : "";
        current = yield* awaitResource(
          createdId.length > 0 ? createdId : (output?.firewallPolicyId ?? ""),
          parentId,
          shortName,
        );
      }

      if (current === undefined) {
        return yield* new FirewallPolicyNotResolved({
          firewallPolicyId: output?.firewallPolicyId ?? "",
          shortName,
        });
      }

      const firewallPolicyId = policyIdOf(current);

      if ((current.description ?? "") !== desiredDescription) {
        yield* runOp(
          firewallPolicyId,
          parentId,
          compute.patchFirewallPolicies({
            firewallPolicy: firewallPolicyId,
            body: {
              description: desiredDescription,
              fingerprint: current.fingerprint,
            },
          }),
        );
        current = (yield* getById(firewallPolicyId)) ?? current;
      }

      const nextRules = desiredRules(news, current.rules ?? []);
      if (nextRules !== undefined) {
        yield* syncRules(
          firewallPolicyId,
          parentId,
          current.rules ?? [],
          nextRules,
        );
        current = (yield* getById(firewallPolicyId)) ?? current;
      }

      if (current === undefined) {
        return yield* new FirewallPolicyNotResolved({
          firewallPolicyId,
          shortName,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const firewallPolicyId = output.firewallPolicyId;
      if (firewallPolicyId.length === 0) return;
      const parentId =
        output.parent.length > 0 ? normalizeParent(output.parent) : undefined;
      yield* compute
        .deleteFirewallPolicies({
          firewallPolicy: firewallPolicyId,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitOrganizationOperation(operation, parentId ?? "", {
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
      yield* waitUntilGone(firewallPolicyId);
    }),
  });
