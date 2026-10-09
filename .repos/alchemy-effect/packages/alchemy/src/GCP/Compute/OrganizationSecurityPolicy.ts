import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import {
  encodeDescription,
  ignoredCodes,
  hasOwnershipMarker,
  lastSegment,
  parseDescription,
  sameJson,
  sorted,
  toPhysicalName,
} from "./internal.ts";
import { waitOrganizationOperation } from "./operations.ts";
import type {
  SecurityPolicyAdaptiveProtectionConfig,
  SecurityPolicyAdvancedOptionsConfig,
  SecurityPolicyDdosProtectionConfig,
  SecurityPolicyRecaptchaOptionsConfig,
  SecurityPolicyRule,
  SecurityPolicyRuleMatcher,
  SecurityPolicyType,
  SecurityPolicyUserDefinedField,
} from "./SecurityPolicy.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_TYPE = "CLOUD_ARMOR";
const DEFAULT_RULE_PRIORITY = 2147483647;

export type OrganizationSecurityPolicyType = SecurityPolicyType;
export type OrganizationSecurityPolicyRule = SecurityPolicyRule;
export type OrganizationSecurityPolicyRuleMatcher = SecurityPolicyRuleMatcher;

export type OrganizationSecurityPolicyProps = {
  /**
   * User-provided RFC1035 name (`shortName`). Unique within the parent
   * organization. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Immutable — changing it replaces the policy.
   * After create, GCP also assigns a numeric `name`.
   */
  shortName?: string;
  /**
   * Parent organization or folder. Format `organizations/{organization}`
   * or `folders/{folder}`. If omitted, Alchemy uses the project parent
   * from Cloud Resource Manager. Immutable — changing it replaces the
   * policy.
   */
  parent?: string;
  /**
   * Optional description. Organization security policies have no
   * `setLabels` API, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Intended use of the policy. Set only at create time — changing it
   * replaces the policy.
   * @default "CLOUD_ARMOR"
   */
  type?: OrganizationSecurityPolicyType;
  /**
   * Ordered Cloud Armor rules. There must always be a default rule at
   * priority `2147483647` matching `*`. If omitted on create, GCP adds
   * an `allow` default. When this field is set, Alchemy syncs rules with
   * `addRule` / `patchRule` / `removeRule`. When omitted on later
   * updates, observed rules are left in place.
   */
  rules?: OrganizationSecurityPolicyRule[];
  /**
   * JSON parsing, log level, and related WAF options. Only applied when
   * set.
   */
  advancedOptionsConfig?: SecurityPolicyAdvancedOptionsConfig;
  /**
   * Cloud Armor Adaptive Protection. Only applied when set.
   */
  adaptiveProtectionConfig?: SecurityPolicyAdaptiveProtectionConfig;
  /**
   * reCAPTCHA site key used by `redirect` rules of type
   * `GOOGLE_RECAPTCHA`. Only applied when set.
   */
  recaptchaOptionsConfig?: SecurityPolicyRecaptchaOptionsConfig;
  /**
   * Network DDoS protection (`STANDARD` or `ADVANCED`). Only applied
   * when set.
   */
  ddosProtectionConfig?: SecurityPolicyDdosProtectionConfig;
  /**
   * Packet field extractors for `CLOUD_ARMOR_NETWORK` policies. Only
   * applied when set.
   */
  userDefinedFields?: SecurityPolicyUserDefinedField[];
};

export type OrganizationSecurityPolicy = Resource<
  "GCP.Compute.OrganizationSecurityPolicy",
  OrganizationSecurityPolicyProps,
  {
    /** User-provided RFC1035 name. */
    shortName: string;
    /** Server-assigned numeric policy id (`name` in the API). */
    securityPolicyId: string;
    /** Parent `organizations/{organization}` or `folders/{folder}`. */
    parent: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Policy type. */
    type: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Rules currently attached (including the default). */
    rules: OrganizationSecurityPolicyRule[];
    /** Advanced WAF options, if configured. */
    advancedOptionsConfig: SecurityPolicyAdvancedOptionsConfig | undefined;
    /** Adaptive Protection config, if configured. */
    adaptiveProtectionConfig:
      | SecurityPolicyAdaptiveProtectionConfig
      | undefined;
    /** reCAPTCHA options, if configured. */
    recaptchaOptionsConfig: SecurityPolicyRecaptchaOptionsConfig | undefined;
    /** DDoS protection config, if configured. */
    ddosProtectionConfig: SecurityPolicyDdosProtectionConfig | undefined;
    /** User-defined packet fields, if configured. */
    userDefinedFields: SecurityPolicyUserDefinedField[];
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id (same as `securityPolicyId` when present). */
    id: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Cloud Armor security policy.
 *
 * Organization security policies live under
 * `locations/global/securityPolicies` and are identified by a
 * server-assigned numeric id. The user-facing name is `shortName`. Parent
 * and type are immutable. Description and WAF options update in place via
 * `organizationSecurityPolicies.patch`. Rules are synced with `addRule` /
 * `patchRule` / `removeRule`.
 *
 * ### Creating an Organization Security Policy
 * **Example:** Generated name with a deny rule
 * ```typescript
 * const policy = yield* GCP.Compute.OrganizationSecurityPolicy("OrgArmor", {
 *   description: "deny a scanner",
 *   rules: [
 *     {
 *       action: "deny(403)",
 *       priority: 1000,
 *       match: {
 *         versionedExpr: "SRC_IPS_V1",
 *         config: { srcIpRanges: ["9.9.9.0/24"] },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Named policy under an organization
 * ```typescript
 * const policy = yield* GCP.Compute.OrganizationSecurityPolicy("OrgArmor", {
 *   shortName: "app-org-armor",
 *   parent: "organizations/123456789",
 *   description: "org WAF",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const OrganizationSecurityPolicy = Resource<OrganizationSecurityPolicy>(
  "GCP.Compute.OrganizationSecurityPolicy",
);

export class OrganizationSecurityPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.OrganizationSecurityPolicyNotResolved",
)<{
  securityPolicyId: string;
  shortName: string;
}> {}

export class OrganizationSecurityPolicyParentRequired extends Data.TaggedError(
  "GCP.Compute.OrganizationSecurityPolicyParentRequired",
)<{
  project: string;
}> {}

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

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
  news: { parent?: string },
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
    return yield* new OrganizationSecurityPolicyParentRequired({
      project: env.project,
    });
  });

const listParents = (project: string) =>
  Effect.gen(function* () {
    const parents = new Set<string>();
    const fromProject = yield* projectParent(project);
    if (fromProject !== undefined) parents.add(fromProject);
    return [...parents];
  });

const canonMatch = (match: SecurityPolicyRuleMatcher | undefined) => {
  if (match === undefined) return undefined;
  return {
    versionedExpr: match.versionedExpr,
    config: match.config
      ? { srcIpRanges: sorted(match.config.srcIpRanges) }
      : undefined,
    expr: match.expr,
    exprOptions: match.exprOptions,
  };
};

const canonRule = (rule: SecurityPolicyRule) => ({
  priority: rule.priority,
  action: rule.action,
  description: rule.description ?? "",
  preview: rule.preview === true,
  match: canonMatch(rule.match),
  redirectOptions: rule.redirectOptions ?? null,
  rateLimitOptions: rule.rateLimitOptions ?? null,
  headerAction: rule.headerAction ?? null,
  preconfiguredWafConfig: rule.preconfiguredWafConfig ?? null,
  networkMatch: rule.networkMatch ?? null,
});

const ruleEquals = (left: SecurityPolicyRule, right: SecurityPolicyRule) =>
  sameJson(canonRule(left), canonRule(right));

const toRuleBody = (rule: SecurityPolicyRule): SecurityPolicyRule => ({
  priority: rule.priority,
  action: rule.action,
  description: rule.description,
  preview: rule.preview === true ? true : undefined,
  match: rule.match,
  redirectOptions: rule.redirectOptions,
  rateLimitOptions: rule.rateLimitOptions,
  headerAction: rule.headerAction,
  preconfiguredWafConfig: rule.preconfiguredWafConfig,
  networkMatch: rule.networkMatch,
});

const defaultAllowRule = (): SecurityPolicyRule => ({
  action: "allow",
  priority: DEFAULT_RULE_PRIORITY,
  match: {
    versionedExpr: "SRC_IPS_V1",
    config: { srcIpRanges: ["*"] },
  },
});

const withDefaultRule = (
  rules: readonly SecurityPolicyRule[] | undefined,
): SecurityPolicyRule[] | undefined => {
  if (rules === undefined) return undefined;
  const bodies = rules.map(toRuleBody);
  if (bodies.some((rule) => rule.priority === DEFAULT_RULE_PRIORITY)) {
    return bodies;
  }
  return [...bodies, defaultAllowRule()];
};

const desiredRules = (
  news: OrganizationSecurityPolicyProps,
  observed: readonly SecurityPolicyRule[],
): SecurityPolicyRule[] | undefined => {
  if (news.rules === undefined) return undefined;
  const byPriority = new Map<number, SecurityPolicyRule>();
  for (const rule of news.rules) {
    if (rule.priority === undefined) continue;
    byPriority.set(rule.priority, rule);
  }
  if (!byPriority.has(DEFAULT_RULE_PRIORITY)) {
    const observedDefault = observed.find(
      (rule) => rule.priority === DEFAULT_RULE_PRIORITY,
    );
    byPriority.set(
      DEFAULT_RULE_PRIORITY,
      observedDefault ?? defaultAllowRule(),
    );
  }
  return [...byPriority.values()].sort(
    (left, right) => (left.priority ?? 0) - (right.priority ?? 0),
  );
};

const subsetEqual = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (typeof desired !== typeof observed) return false;
  if (desired === null || observed === null) return desired === observed;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || desired.length !== observed.length) {
      return false;
    }
    return desired.every((item, index) => subsetEqual(observed[index], item));
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object") return false;
    const current = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => value === undefined || subsetEqual(current[key], value),
    );
  }
  return observed === desired;
};

const policyIdOf = (policy: compute.SecurityPolicy) =>
  policy.name ?? policy.id ?? lastSegment(policy.selfLink);

const toAttrs = (
  policy: compute.SecurityPolicy,
  project: string,
): OrganizationSecurityPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    shortName: policy.shortName ?? policy.name ?? "",
    securityPolicyId: policyIdOf(policy),
    parent: policy.parent ?? "",
    project,
    type: typeOf(policy.type),
    description: parsed.description,
    rules: policy.rules ?? [],
    advancedOptionsConfig: policy.advancedOptionsConfig,
    adaptiveProtectionConfig: policy.adaptiveProtectionConfig,
    recaptchaOptionsConfig: policy.recaptchaOptionsConfig,
    ddosProtectionConfig: policy.ddosProtectionConfig,
    userDefinedFields: policy.userDefinedFields ?? [],
    fingerprint: policy.fingerprint,
    selfLink: policy.selfLink,
    id: policy.id,
    creationTimestamp: policy.creationTimestamp,
    kind: policy.kind,
  };
};

const getById = (securityPolicy: string) =>
  compute
    .getOrganizationSecurityPolicies({ securityPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findByShortName = (parentId: string, shortName: string) =>
  compute.listOrganizationSecurityPolicies
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
  securityPolicyId: string | undefined,
  parentId: string,
  shortName: string,
) =>
  Effect.gen(function* () {
    if (securityPolicyId !== undefined && securityPolicyId.length > 0) {
      const existing = yield* getById(securityPolicyId);
      if (existing !== undefined) return existing;
    }
    return yield* findByShortName(parentId, shortName);
  });

const runOp = <E extends { readonly _tag: string }, R>(
  securityPolicyId: string,
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

const idFromOperation = (operation: compute.Operation) => {
  if (operation.targetId !== undefined && operation.targetId.length > 0) {
    return operation.targetId;
  }
  const fromLink = lastSegment(operation.targetLink);
  return fromLink.length > 0 ? fromLink : "";
};

const awaitResource = (
  securityPolicyId: string,
  parentId: string,
  shortName: string,
) =>
  observe(securityPolicyId, parentId, shortName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(
            new OrganizationSecurityPolicyNotResolved({
              securityPolicyId,
              shortName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.OrganizationSecurityPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const syncRules = (
  securityPolicyId: string,
  parentId: string,
  observed: readonly SecurityPolicyRule[],
  desired: readonly SecurityPolicyRule[],
) =>
  Effect.gen(function* () {
    const observedByPriority = new Map<number, SecurityPolicyRule>();
    for (const rule of observed) {
      if (rule.priority !== undefined) {
        observedByPriority.set(rule.priority, rule);
      }
    }
    const desiredByPriority = new Map<number, SecurityPolicyRule>();
    for (const rule of desired) {
      if (rule.priority !== undefined) {
        desiredByPriority.set(rule.priority, rule);
      }
    }

    for (const [priority, rule] of desiredByPriority) {
      const current = observedByPriority.get(priority);
      if (current === undefined) {
        yield* runOp(
          securityPolicyId,
          parentId,
          compute.addRuleOrganizationSecurityPolicies({
            securityPolicy: securityPolicyId,
            body: toRuleBody(rule),
          }),
          { ignoreAlreadyExists: true },
        );
        continue;
      }
      if (!ruleEquals(current, rule)) {
        yield* runOp(
          securityPolicyId,
          parentId,
          compute.patchRuleOrganizationSecurityPolicies({
            securityPolicy: securityPolicyId,
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
        securityPolicyId,
        parentId,
        compute.removeRuleOrganizationSecurityPolicies({
          securityPolicy: securityPolicyId,
          priority,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }
  });

export const OrganizationSecurityPolicyProvider = () =>
  Provider.succeed(OrganizationSecurityPolicy, {
    stables: [
      "shortName",
      "securityPolicyId",
      "parent",
      "project",
      "type",
      "id",
      "selfLink",
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
      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? output?.type);
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (parentChanged || previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const shortName = yield* toPhysicalName(
        id,
        olds?.shortName,
        output?.shortName,
        "policy",
      );
      const parent = yield* resolveParent(olds ?? {}, output).pipe(
        Effect.catchTag(
          "GCP.Compute.OrganizationSecurityPolicyParentRequired",
          () => Effect.succeed(output?.parent ?? olds?.parent ?? ""),
        ),
      );
      const existing = yield* observe(
        output?.securityPolicyId,
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
        const listed: OrganizationSecurityPolicy["Attributes"][] = [];
        for (const parentId of parents) {
          const chunk = yield* compute.listOrganizationSecurityPolicies
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
                Effect.succeed(
                  [] as OrganizationSecurityPolicy["Attributes"][],
                ),
              ),
            );
          listed.push(...chunk);
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const shortName = yield* toPhysicalName(
        id,
        news.shortName,
        output?.shortName,
        "policy",
      );
      const parentId = yield* resolveParent(news, output);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* observe(
        output?.securityPolicyId,
        parentId,
        shortName,
      );

      if (current === undefined) {
        const inserted = yield* runOp(
          shortName,
          parentId,
          compute.insertOrganizationSecurityPolicies({
            parentId,
            body: {
              shortName,
              description: desiredDescription,
              type: typeOf(news.type),
              rules: withDefaultRule(news.rules),
              advancedOptionsConfig: news.advancedOptionsConfig,
              adaptiveProtectionConfig: news.adaptiveProtectionConfig,
              recaptchaOptionsConfig: news.recaptchaOptionsConfig,
              ddosProtectionConfig: news.ddosProtectionConfig,
              userDefinedFields: news.userDefinedFields,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        const createdId =
          inserted !== undefined ? idFromOperation(inserted) : "";
        current = yield* awaitResource(
          createdId.length > 0 ? createdId : (output?.securityPolicyId ?? ""),
          parentId,
          shortName,
        );
      }

      if (current === undefined) {
        return yield* new OrganizationSecurityPolicyNotResolved({
          securityPolicyId: output?.securityPolicyId ?? "",
          shortName,
        });
      }

      const securityPolicyId = policyIdOf(current);
      const patch: compute.SecurityPolicy = {
        fingerprint: current.fingerprint,
      };
      let needsPatch = false;
      if ((current.description ?? "") !== desiredDescription) {
        patch.description = desiredDescription;
        needsPatch = true;
      }
      if (
        news.advancedOptionsConfig !== undefined &&
        !subsetEqual(current.advancedOptionsConfig, news.advancedOptionsConfig)
      ) {
        patch.advancedOptionsConfig = news.advancedOptionsConfig;
        needsPatch = true;
      }
      if (
        news.adaptiveProtectionConfig !== undefined &&
        !subsetEqual(
          current.adaptiveProtectionConfig,
          news.adaptiveProtectionConfig,
        )
      ) {
        patch.adaptiveProtectionConfig = news.adaptiveProtectionConfig;
        needsPatch = true;
      }
      if (
        news.recaptchaOptionsConfig !== undefined &&
        !subsetEqual(
          current.recaptchaOptionsConfig,
          news.recaptchaOptionsConfig,
        )
      ) {
        patch.recaptchaOptionsConfig = news.recaptchaOptionsConfig;
        needsPatch = true;
      }
      if (
        news.ddosProtectionConfig !== undefined &&
        !subsetEqual(current.ddosProtectionConfig, news.ddosProtectionConfig)
      ) {
        patch.ddosProtectionConfig = news.ddosProtectionConfig;
        needsPatch = true;
      }
      if (
        news.userDefinedFields !== undefined &&
        !sameJson(current.userDefinedFields ?? [], news.userDefinedFields)
      ) {
        patch.userDefinedFields = news.userDefinedFields;
        needsPatch = true;
      }
      if (needsPatch) {
        yield* runOp(
          securityPolicyId,
          parentId,
          compute.patchOrganizationSecurityPolicies({
            securityPolicy: securityPolicyId,
            body: patch,
          }),
        );
        current = (yield* getById(securityPolicyId)) ?? current;
      }

      const nextRules = desiredRules(news, current.rules ?? []);
      if (nextRules !== undefined) {
        yield* syncRules(
          securityPolicyId,
          parentId,
          current.rules ?? [],
          nextRules,
        );
        current = (yield* getById(securityPolicyId)) ?? current;
      }

      if (current === undefined) {
        return yield* new OrganizationSecurityPolicyNotResolved({
          securityPolicyId,
          shortName,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const securityPolicyId = output.securityPolicyId;
      if (securityPolicyId.length === 0) return;
      const parentId =
        output.parent.length > 0 ? normalizeParent(output.parent) : undefined;
      yield* compute
        .deleteOrganizationSecurityPolicies({
          securityPolicy: securityPolicyId,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitOrganizationOperation(operation, parentId, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
    }),
  });
