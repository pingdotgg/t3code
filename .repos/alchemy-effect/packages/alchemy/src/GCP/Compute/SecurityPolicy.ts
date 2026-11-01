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
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_TYPE = "CLOUD_ARMOR";
const DEFAULT_RULE_PRIORITY = 2147483647;
const MAX_NAME_LENGTH = 63;

export type SecurityPolicyType = compute.SecurityPolicyTypeEnum | (string & {});
export type SecurityPolicyRule = compute.SecurityPolicyRule;
export type SecurityPolicyRuleMatcher = compute.SecurityPolicyRuleMatcher;
export type SecurityPolicyAdvancedOptionsConfig =
  compute.SecurityPolicyAdvancedOptionsConfig;
export type SecurityPolicyAdaptiveProtectionConfig =
  compute.SecurityPolicyAdaptiveProtectionConfig;
export type SecurityPolicyRecaptchaOptionsConfig =
  compute.SecurityPolicyRecaptchaOptionsConfig;
export type SecurityPolicyDdosProtectionConfig =
  compute.SecurityPolicyDdosProtectionConfig;
export type SecurityPolicyUserDefinedField =
  compute.SecurityPolicyUserDefinedField;

export type SecurityPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the policy.
   */
  securityPolicyName?: string;
  /**
   * Intended use of the policy. Set only at create time — changing it
   * replaces the policy.
   * @default "CLOUD_ARMOR"
   */
  type?: SecurityPolicyType;
  /**
   * Optional description. Mutable in place via `securityPolicies.patch`.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels (`alchemy-stack` /
   * `alchemy-stage` / `alchemy-id`) are merged in automatically and
   * synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
  /**
   * Ordered Cloud Armor rules. There must always be a default rule at
   * priority `2147483647` matching `*`. If omitted on create, GCP adds
   * an `allow` default. When this field is set, Alchemy syncs rules with
   * `addRule` / `patchRule` / `removeRule` (not `patch`). When omitted
   * on later updates, observed rules are left in place.
   */
  rules?: SecurityPolicyRule[];
  /**
   * JSON parsing, log level, and related WAF options. Only applied when
   * set; omitted values leave the observed config in place.
   */
  advancedOptionsConfig?: SecurityPolicyAdvancedOptionsConfig;
  /**
   * Cloud Armor Adaptive Protection (CAAP). Global `CLOUD_ARMOR` only.
   * Only applied when set.
   */
  adaptiveProtectionConfig?: SecurityPolicyAdaptiveProtectionConfig;
  /**
   * reCAPTCHA site key used by `redirect` rules of type
   * `GOOGLE_RECAPTCHA`. Global `CLOUD_ARMOR` only. Only applied when set.
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

export type SecurityPolicy = Resource<
  "GCP.Compute.SecurityPolicy",
  SecurityPolicyProps,
  {
    /** Policy name. */
    securityPolicyName: string;
    /** Project id. */
    project: string;
    /** Policy type (`CLOUD_ARMOR`, `CLOUD_ARMOR_EDGE`, …). */
    type: string;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Rules currently attached to the policy (including the default). */
    rules: SecurityPolicyRule[];
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
    /** Optimistic-locking fingerprint for metadata patches. */
    fingerprint: string | undefined;
    /** Label fingerprint for `setLabels`. */
    labelFingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    securityPolicyId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Cloud Armor security policy that filters HTTP(S) requests
 * targeting backend services (and, for `CLOUD_ARMOR_EDGE`, backend
 * buckets).
 *
 * Type is immutable — changing it replaces the policy. Name is
 * immutable. Description, advanced options, Adaptive Protection,
 * reCAPTCHA, DDoS config, and user-defined fields update in place via
 * `securityPolicies.patch`. Rules are synced with `addRule` /
 * `patchRule` / `removeRule` (not `patch`). Labels are applied with
 * `setLabels` after the policy exists.
 *
 * ### Creating a Security Policy
 * **Example:** Generated name with a deny rule
 * ```typescript
 * const policy = yield* GCP.Compute.SecurityPolicy("Armor", {
 *   description: "deny a scanner",
 *   rules: [
 *     {
 *       action: "deny(403)",
 *       priority: 1000,
 *       description: "block scanner",
 *       match: {
 *         versionedExpr: "SRC_IPS_V1",
 *         config: { srcIpRanges: ["9.9.9.0/24"] },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Named policy with labels
 * ```typescript
 * const policy = yield* GCP.Compute.SecurityPolicy("Armor", {
 *   securityPolicyName: "app-armor",
 *   type: "CLOUD_ARMOR",
 *   description: "prod WAF",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Advanced Options
 * **Example:** JSON parsing and verbose logs
 * ```typescript
 * const policy = yield* GCP.Compute.SecurityPolicy("Armor", {
 *   advancedOptionsConfig: {
 *     jsonParsing: "STANDARD",
 *     logLevel: "VERBOSE",
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const SecurityPolicy = Resource<SecurityPolicy>(
  "GCP.Compute.SecurityPolicy",
);

export class SecurityPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.SecurityPolicyNotResolved",
)<{
  securityPolicyName: string;
}> {}

export class SecurityPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.SecurityPolicyStillExists",
)<{
  securityPolicyName: string;
}> {}

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `s${next}`;
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

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

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

const defaultAllowRule = (): SecurityPolicyRule => ({
  action: "allow",
  priority: DEFAULT_RULE_PRIORITY,
  match: {
    versionedExpr: "SRC_IPS_V1",
    config: { srcIpRanges: ["*"] },
  },
});

const desiredRules = (
  news: SecurityPolicyProps,
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

const toAttrs = (policy: compute.SecurityPolicy, project: string) => ({
  securityPolicyName: policy.name ?? policy.id ?? "",
  project,
  type: typeOf(policy.type),
  description: policy.description,
  labels: userLabels(policy.labels),
  rules: policy.rules ?? [],
  advancedOptionsConfig: policy.advancedOptionsConfig,
  adaptiveProtectionConfig: policy.adaptiveProtectionConfig,
  recaptchaOptionsConfig: policy.recaptchaOptionsConfig,
  ddosProtectionConfig: policy.ddosProtectionConfig,
  userDefinedFields: policy.userDefinedFields ?? [],
  fingerprint: policy.fingerprint,
  labelFingerprint: policy.labelFingerprint,
  selfLink: policy.selfLink,
  securityPolicyId: policy.id,
  creationTimestamp: policy.creationTimestamp,
  kind: policy.kind,
});

const getByName = (project: string, securityPolicy: string) =>
  compute
    .getSecurityPolicies({ project, securityPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, securityPolicyName: string) =>
  getByName(project, securityPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(new SecurityPolicyNotResolved({ securityPolicyName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.SecurityPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, securityPolicyName: string) =>
  getByName(project, securityPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new SecurityPolicyStillExists({ securityPolicyName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.SecurityPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.Compute.SecurityPolicyStillExists", () => Effect.void),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  securityPolicyName: string,
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

const insertBody = (
  securityPolicyName: string,
  news: SecurityPolicyProps,
): compute.SecurityPolicy => ({
  name: securityPolicyName,
  description: news.description,
  type: typeOf(news.type),
  rules: withDefaultRule(news.rules),
  advancedOptionsConfig: news.advancedOptionsConfig,
  adaptiveProtectionConfig: news.adaptiveProtectionConfig,
  recaptchaOptionsConfig: news.recaptchaOptionsConfig,
  ddosProtectionConfig: news.ddosProtectionConfig,
  userDefinedFields: news.userDefinedFields,
});

const syncRules = (
  project: string,
  securityPolicyName: string,
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
          project,
          securityPolicyName,
          compute.addRuleSecurityPolicies({
            project,
            securityPolicy: securityPolicyName,
            body: toRuleBody(rule),
          }),
          { ignoreAlreadyExists: true },
        );
        continue;
      }
      if (!ruleEquals(current, rule)) {
        yield* runOp(
          project,
          securityPolicyName,
          compute.patchRuleSecurityPolicies({
            project,
            securityPolicy: securityPolicyName,
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
        project,
        securityPolicyName,
        compute.removeRuleSecurityPolicies({
          project,
          securityPolicy: securityPolicyName,
          priority,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

export const SecurityPolicyProvider = () =>
  Provider.succeed(SecurityPolicy, {
    stables: [
      "securityPolicyName",
      "project",
      "type",
      "securityPolicyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName =
        olds?.securityPolicyName ?? output?.securityPolicyName;
      const nextName = news.securityPolicyName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? output?.type);
      const typeChanged = previousType !== nextType;

      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (typeChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const securityPolicyName = yield* toName(
        id,
        olds?.securityPolicyName,
        output?.securityPolicyName,
      );
      const existing = yield* getByName(env.project, securityPolicyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listSecurityPolicies
          .items({
            project: env.project,
            maxResults: 500,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((policy) =>
              Object.keys(policy.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((policy) => toAttrs(policy, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const securityPolicyName = yield* toName(
        id,
        news.securityPolicyName,
        output?.securityPolicyName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, securityPolicyName);

      if (current === undefined) {
        yield* compute
          .insertSecurityPolicies({
            project: env.project,
            body: insertBody(securityPolicyName, news),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, securityPolicyName);
      }

      if (current === undefined) {
        return yield* new SecurityPolicyNotResolved({ securityPolicyName });
      }

      const patch: compute.SecurityPolicy = {
        fingerprint: current.fingerprint,
      };
      let needsPatch = false;

      if ((current.description ?? "") !== (news.description ?? "")) {
        patch.description = news.description ?? "";
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
          env.project,
          securityPolicyName,
          compute.patchSecurityPolicies({
            project: env.project,
            securityPolicy: securityPolicyName,
            body: patch,
          }),
        );
        current =
          (yield* getByName(env.project, securityPolicyName)) ?? current;
      }

      const nextRules = desiredRules(news, current.rules ?? []);
      if (nextRules !== undefined) {
        yield* syncRules(
          env.project,
          securityPolicyName,
          current.rules ?? [],
          nextRules,
        );
        current =
          (yield* getByName(env.project, securityPolicyName)) ?? current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* runOp(
          env.project,
          securityPolicyName,
          compute.setLabelsSecurityPolicies({
            project: env.project,
            resource: securityPolicyName,
            body: {
              labels: desiredLabels,
              labelFingerprint: current.labelFingerprint,
            },
          }),
        );
        current =
          (yield* getByName(env.project, securityPolicyName)) ?? current;
      }

      if (current === undefined) {
        return yield* new SecurityPolicyNotResolved({ securityPolicyName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      yield* compute
        .deleteSecurityPolicies({
          project,
          securityPolicy: output.securityPolicyName,
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
      yield* waitUntilGone(project, output.securityPolicyName);
    }),
  });
