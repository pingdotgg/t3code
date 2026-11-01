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

const DEFAULT_TYPE = "CLOUD_ARMOR";
const DEFAULT_RULE_PRIORITY = 2147483647;
const MAX_NAME_LENGTH = 63;

export type RegionSecurityPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the policy.
   */
  securityPolicyName?: string;
  /**
   * Region the policy lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Intended use of the policy. Set only at create time — changing it
   * replaces the policy.
   * @default "CLOUD_ARMOR"
   */
  type?: SecurityPolicyType;
  /**
   * Optional description. Mutable in place via `regionSecurityPolicies.patch`.
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
   * Cloud Armor Adaptive Protection (CAAP). Only applied when set.
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

export type RegionSecurityPolicy = Resource<
  "GCP.Compute.RegionSecurityPolicy",
  RegionSecurityPolicyProps,
  {
    /** Policy name. */
    securityPolicyName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
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
 * A regional Cloud Armor security policy that filters HTTP(S) requests
 * targeting regional backend services.
 *
 * Type and region are immutable — changing either replaces the policy.
 * Description, advanced options, Adaptive Protection, reCAPTCHA, DDoS
 * config, and user-defined fields update in place via
 * `regionSecurityPolicies.patch`. Rules are synced with `addRule` /
 * `patchRule` / `removeRule` (not `patch`). Labels are applied with
 * `setLabels` after the policy exists.
 *
 * ### Creating a Regional Security Policy
 * **Example:** Generated name with a deny rule
 * ```typescript
 * const policy = yield* GCP.Compute.RegionSecurityPolicy("Armor", {
 *   region: "us-central1",
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
 * @resource
 * @category Compute
 */
export const RegionSecurityPolicy = Resource<RegionSecurityPolicy>(
  "GCP.Compute.RegionSecurityPolicy",
);

export class RegionSecurityPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionSecurityPolicyNotResolved",
)<{
  securityPolicyName: string;
  region: string;
}> {}

export class RegionSecurityPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.RegionSecurityPolicyStillExists",
)<{
  securityPolicyName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
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
  news: RegionSecurityPolicyProps,
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
  region: lastSegment(policy.region).toLowerCase(),
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

const getByName = (project: string, region: string, securityPolicy: string) =>
  compute
    .getRegionSecurityPolicies({ project, region, securityPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  securityPolicyName: string,
) =>
  getByName(project, region, securityPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy !== undefined
        ? Effect.succeed(policy)
        : Effect.fail(
            new RegionSecurityPolicyNotResolved({
              securityPolicyName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionSecurityPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  securityPolicyName: string,
) =>
  getByName(project, region, securityPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(
            new RegionSecurityPolicyStillExists({
              securityPolicyName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionSecurityPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.RegionSecurityPolicyStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  securityPolicyName: string,
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
  securityPolicyName: string,
  news: RegionSecurityPolicyProps,
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
  region: string,
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
          region,
          securityPolicyName,
          compute.addRuleRegionSecurityPolicies({
            project,
            region,
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
          region,
          securityPolicyName,
          compute.patchRuleRegionSecurityPolicies({
            project,
            region,
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
        region,
        securityPolicyName,
        compute.removeRuleRegionSecurityPolicies({
          project,
          region,
          securityPolicy: securityPolicyName,
          priority,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

export const RegionSecurityPolicyProvider = () =>
  Provider.succeed(RegionSecurityPolicy, {
    stables: [
      "securityPolicyName",
      "project",
      "region",
      "type",
      "securityPolicyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName =
        olds?.securityPolicyName ?? output?.securityPolicyName;
      const nextName = news.securityPolicyName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? output?.type);
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
      const securityPolicyName = yield* toName(
        id,
        olds?.securityPolicyName,
        output?.securityPolicyName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        securityPolicyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListSecurityPolicies
          .pages({
            project: env.project,
            maxResults: 500,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.securityPolicies ?? [])
              .filter((policy) => (policy.region ?? "").length > 0)
              .filter((policy) =>
                Object.keys(policy.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((policy) => toAttrs(policy, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const securityPolicyName = yield* toName(
        id,
        news.securityPolicyName,
        output?.securityPolicyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, securityPolicyName);

      if (current === undefined) {
        yield* compute
          .insertRegionSecurityPolicies({
            project: env.project,
            region,
            body: insertBody(securityPolicyName, news),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, region, securityPolicyName);
      }

      if (current === undefined) {
        return yield* new RegionSecurityPolicyNotResolved({
          securityPolicyName,
          region,
        });
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
          region,
          securityPolicyName,
          compute.patchRegionSecurityPolicies({
            project: env.project,
            region,
            securityPolicy: securityPolicyName,
            body: patch,
          }),
        );
        current =
          (yield* getByName(env.project, region, securityPolicyName)) ??
          current;
      }

      const nextRules = desiredRules(news, current.rules ?? []);
      if (nextRules !== undefined) {
        yield* syncRules(
          env.project,
          region,
          securityPolicyName,
          current.rules ?? [],
          nextRules,
        );
        current =
          (yield* getByName(env.project, region, securityPolicyName)) ??
          current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* runOp(
          env.project,
          region,
          securityPolicyName,
          compute.setLabelsRegionSecurityPolicies({
            project: env.project,
            region,
            resource: securityPolicyName,
            body: {
              labels: desiredLabels,
              labelFingerprint: current.labelFingerprint,
            },
          }),
        );
        current =
          (yield* getByName(env.project, region, securityPolicyName)) ??
          current;
      }

      if (current === undefined) {
        return yield* new RegionSecurityPolicyNotResolved({
          securityPolicyName,
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
        .deleteRegionSecurityPolicies({
          project,
          region,
          securityPolicy: output.securityPolicyName,
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
      yield* waitUntilGone(project, region, output.securityPolicyName);
    }),
  });
