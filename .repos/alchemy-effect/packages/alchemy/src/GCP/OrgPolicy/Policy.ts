import * as orgpolicy from "@distilled.cloud/gcp/orgpolicy_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type PolicyParentKind = "projects" | "folders" | "organizations";

export type PolicyRuleValues = {
  /**
   * Values allowed at this resource. List constraints only.
   */
  allowedValues?: string[];
  /**
   * Values denied at this resource. List constraints only.
   */
  deniedValues?: string[];
};

export type PolicyRuleCondition = {
  /**
   * CEL expression. Must use `resource.matchTag`, `resource.matchTagId`,
   * `resource.hasTagKey`, or `resource.hasTagKeyId`.
   */
  expression?: string;
  /**
   * Short title shown in UIs.
   */
  title?: string;
  /**
   * Longer description of the condition.
   */
  description?: string;
  /**
   * Location string for error reporting.
   */
  location?: string;
};

export type PolicyRule = {
  /**
   * Allow every value. List constraints only.
   */
  allowAll?: boolean;
  /**
   * Deny every value. List constraints only.
   */
  denyAll?: boolean;
  /**
   * When true, the boolean/managed constraint is enforced. When false,
   * any configuration is acceptable. Boolean constraints only.
   */
  enforce?: boolean;
  /**
   * Allowed and denied values. List constraints only.
   */
  values?: PolicyRuleValues;
  /**
   * Tag-based CEL condition that selects when this rule applies.
   */
  condition?: PolicyRuleCondition;
  /**
   * Parameter values for managed constraints.
   */
  parameters?: Record<string, unknown>;
};

export type PolicySpec = {
  /**
   * When true, list-constraint rules from ancestors are inherited.
   * List constraints only.
   */
  inheritFromParent?: boolean;
  /**
   * Restore the constraint default at this resource. When true, `rules`
   * must be empty and `inheritFromParent` must be false.
   */
  reset?: boolean;
  /**
   * Policy rules. Boolean constraints must have exactly one rule with no
   * condition.
   */
  rules?: PolicyRule[];
};

export type PolicyProps = {
  /**
   * Constraint this policy configures, e.g. `compute.disableSerialPortAccess`
   * or `constraints/compute.disableSerialPortAccess`. The `constraints/`
   * prefix is stripped. Immutable — changing it replaces the policy.
   */
  constraint: string;
  /**
   * Parent resource: `projects/{project}`, `folders/{folder}`, or
   * `organizations/{organization}`. Defaults to the stack's GCP project.
   * Immutable — changing it replaces the policy. Responses may rewrite a
   * project id to the equivalent project number.
   */
  parent?: string;
  /**
   * Enforcement spec. Omitted on a later update leaves the live spec
   * unchanged.
   */
  spec?: PolicySpec;
  /**
   * Dry-run (audit-only) spec. Omitted on a later update leaves the live
   * dry-run spec unchanged.
   */
  dryRunSpec?: PolicySpec;
};

export type Policy = Resource<
  "GCP.OrgPolicy.Policy",
  PolicyProps,
  {
    /** Full resource name `projects/{project}/policies/{constraint}`. */
    name: string;
    /** Constraint id (no `constraints/` prefix). */
    constraint: string;
    /** Parent `projects/{project}`, `folders/{folder}`, or `organizations/{organization}`. */
    parent: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
    /** Live enforcement spec (`etag` / `updateTime` stripped). */
    spec: PolicySpec | undefined;
    /** Live dry-run spec (`etag` / `updateTime` stripped). */
    dryRunSpec: PolicySpec | undefined;
    /** RFC3339 last-update timestamp from the live spec. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Organization Policy on a project, folder, or organization.
 *
 * Identity is `(parent, constraint)` — the constraint must already exist
 * (built-in or custom). Organization policies have no labels or description
 * field; Alchemy treats existence at the computed name as ownership, and
 * `list` returns every policy set on the current project so `pnpm nuke:gcp`
 * can clean leaks.
 *
 * `constraint` and `parent` are immutable. `spec` and `dryRunSpec` update
 * in place.
 *
 * ### Creating a Policy
 * **Example:** Enforce a boolean constraint on the current project
 * ```typescript
 * const serial = yield* GCP.OrgPolicy.Policy("SerialPort", {
 *   constraint: "compute.disableSerialPortAccess",
 *   spec: {
 *     rules: [{ enforce: true }],
 *   },
 * });
 * ```
 *
 * **Example:** List constraint that allows every value
 * ```typescript
 * const locations = yield* GCP.OrgPolicy.Policy("Locations", {
 *   constraint: "gcp.resourceLocations",
 *   spec: {
 *     inheritFromParent: false,
 *     rules: [{ allowAll: true }],
 *   },
 * });
 * ```
 *
 * ### Dry-run
 * **Example:** Audit-only dry-run spec
 * ```typescript
 * const serial = yield* GCP.OrgPolicy.Policy("SerialPort", {
 *   constraint: "compute.disableSerialPortAccess",
 *   spec: {
 *     rules: [{ enforce: true }],
 *   },
 *   dryRunSpec: {
 *     rules: [{ enforce: true }],
 *   },
 * });
 * ```
 *
 * ### Updating a Policy
 * **Example:** Relax enforcement
 * ```typescript
 * const serial = yield* GCP.OrgPolicy.Policy("SerialPort", {
 *   constraint: "compute.disableSerialPortAccess",
 *   spec: {
 *     rules: [{ enforce: false }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category OrgPolicy
 */
export const Policy = Resource<Policy>("GCP.OrgPolicy.Policy");

export class PolicyNotResolved extends Data.TaggedError(
  "GCP.OrgPolicy.PolicyNotResolved",
)<{
  name: string;
}> {}

const CONSTRAINTS_PREFIX = "constraints/";
const POLICIES_SEGMENT = "/policies/";

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeConstraint = (constraint: string | undefined) => {
  const raw = (constraint ?? "").trim();
  return raw.startsWith(CONSTRAINTS_PREFIX)
    ? raw.slice(CONSTRAINTS_PREFIX.length)
    : raw;
};

const parentKindOf = (resource: string): PolicyParentKind => {
  if (resource.startsWith("folders/")) return "folders";
  if (resource.startsWith("organizations/")) return "organizations";
  return "projects";
};

const defaultParent = (project: string) => `projects/${project}`;

const parsePolicyName = (name: string) => {
  const at = name.indexOf(POLICIES_SEGMENT);
  if (at < 0) {
    return { parent: "", constraint: normalizeConstraint(name) };
  }
  return {
    parent: name.slice(0, at),
    constraint: normalizeConstraint(name.slice(at + POLICIES_SEGMENT.length)),
  };
};

const resourceName = (parent: string, constraint: string) =>
  `${parent}${POLICIES_SEGMENT}${constraint}`;

const sameParent = (desired: string, observed: string, project: string) => {
  if (desired === observed) return true;
  if (parentKindOf(desired) !== parentKindOf(observed)) return false;
  if (lastSegment(desired) === lastSegment(observed)) return true;
  return (
    parentKindOf(desired) === "projects" && lastSegment(desired) === project
  );
};

const toRule = (
  rule: orgpolicy.GoogleCloudOrgpolicyV2PolicySpecPolicyRule | PolicyRule,
): PolicyRule => ({
  allowAll: rule.allowAll,
  denyAll: rule.denyAll,
  enforce: rule.enforce,
  values: rule.values
    ? {
        allowedValues: rule.values.allowedValues,
        deniedValues: rule.values.deniedValues,
      }
    : undefined,
  condition: rule.condition
    ? {
        expression: rule.condition.expression,
        title: rule.condition.title,
        description: rule.condition.description,
        location: rule.condition.location,
      }
    : undefined,
  parameters: rule.parameters as Record<string, unknown> | undefined,
});

const toSpec = (
  spec: orgpolicy.GoogleCloudOrgpolicyV2PolicySpec | PolicySpec | undefined,
): PolicySpec | undefined => {
  if (spec === undefined) return undefined;
  const rules = (spec.rules ?? []).map(toRule);
  const next: PolicySpec = {
    inheritFromParent: spec.inheritFromParent,
    reset: spec.reset,
    rules: rules.length > 0 ? rules : undefined,
  };
  if (
    next.inheritFromParent === undefined &&
    next.reset === undefined &&
    next.rules === undefined
  ) {
    return undefined;
  }
  return next;
};

const toApiSpec = (
  spec: PolicySpec | undefined,
): orgpolicy.GoogleCloudOrgpolicyV2PolicySpec | undefined => {
  if (spec === undefined) return undefined;
  return {
    inheritFromParent: spec.inheritFromParent,
    reset: spec.reset,
    rules: spec.rules?.map((rule) => ({
      allowAll: rule.allowAll,
      denyAll: rule.denyAll,
      enforce: rule.enforce,
      values: rule.values
        ? {
            allowedValues: rule.values.allowedValues,
            deniedValues: rule.values.deniedValues,
          }
        : undefined,
      condition: rule.condition,
      parameters: rule.parameters,
    })),
  };
};

const canonicalizeRule = (rule: PolicyRule) => ({
  allowAll: rule.allowAll === true,
  denyAll: rule.denyAll === true,
  enforce: rule.enforce,
  values: rule.values
    ? {
        allowedValues: [...(rule.values.allowedValues ?? [])].sort(),
        deniedValues: [...(rule.values.deniedValues ?? [])].sort(),
      }
    : undefined,
  condition: rule.condition
    ? {
        expression: rule.condition.expression ?? "",
        title: rule.condition.title ?? "",
        description: rule.condition.description ?? "",
        location: rule.condition.location ?? "",
      }
    : undefined,
  parameters:
    rule.parameters && Object.keys(rule.parameters).length > 0
      ? rule.parameters
      : undefined,
});

const canonicalizeSpec = (spec: PolicySpec | undefined) => ({
  inheritFromParent: spec?.inheritFromParent === true,
  reset: spec?.reset === true,
  rules: (spec?.rules ?? []).map(canonicalizeRule),
});

const specsEqual = (
  left: PolicySpec | undefined,
  right: PolicySpec | undefined,
) =>
  JSON.stringify(canonicalizeSpec(left)) ===
  JSON.stringify(canonicalizeSpec(right));

const toAttrs = (
  policy: orgpolicy.GoogleCloudOrgpolicyV2Policy,
  project: string,
) => {
  const name = policy.name ?? "";
  const parsed = parsePolicyName(name);
  return {
    name,
    constraint: parsed.constraint,
    parent: parsed.parent,
    project,
    etag: policy.etag,
    spec: toSpec(policy.spec),
    dryRunSpec: toSpec(policy.dryRunSpec),
    updateTime: policy.spec?.updateTime,
  };
};

const getByName = (name: string) => {
  const kind = parentKindOf(name);
  const request = { name };
  const get =
    kind === "folders"
      ? orgpolicy.getFoldersPolicies(request)
      : kind === "organizations"
        ? orgpolicy.getOrganizationsPolicies(request)
        : orgpolicy.getProjectsPolicies(request);
  return get.pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
};

const createPolicy = (
  parent: string,
  body: orgpolicy.GoogleCloudOrgpolicyV2Policy,
) => {
  const kind = parentKindOf(parent);
  const request = { parent, body };
  return kind === "folders"
    ? orgpolicy.createFoldersPolicies(request)
    : kind === "organizations"
      ? orgpolicy.createOrganizationsPolicies(request)
      : orgpolicy.createProjectsPolicies(request);
};

const patchPolicy = (
  name: string,
  body: orgpolicy.GoogleCloudOrgpolicyV2Policy,
  updateMask: string,
) => {
  const kind = parentKindOf(name);
  const request = { name, body, updateMask };
  return kind === "folders"
    ? orgpolicy.patchFoldersPolicies(request)
    : kind === "organizations"
      ? orgpolicy.patchOrganizationsPolicies(request)
      : orgpolicy.patchProjectsPolicies(request);
};

const deletePolicy = (name: string) => {
  const kind = parentKindOf(name);
  const request = { name };
  const del =
    kind === "folders"
      ? orgpolicy.deleteFoldersPolicies(request)
      : kind === "organizations"
        ? orgpolicy.deleteOrganizationsPolicies(request)
        : orgpolicy.deleteProjectsPolicies(request);
  return del.pipe(Effect.catchTag("NotFound", () => Effect.void));
};

const listPolicies = (parent: string) =>
  Effect.gen(function* () {
    const kind = parentKindOf(parent);
    const found: orgpolicy.GoogleCloudOrgpolicyV2Policy[] = [];
    let pageToken: string | undefined;
    do {
      const request = { parent, pageSize: 1000, pageToken };
      const response =
        kind === "folders"
          ? yield* orgpolicy.listFoldersPolicies(request)
          : kind === "organizations"
            ? yield* orgpolicy.listOrganizationsPolicies(request)
            : yield* orgpolicy.listProjectsPolicies(request);
      found.push(...(response.policies ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined && pageToken !== "");
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as orgpolicy.GoogleCloudOrgpolicyV2Policy[]),
    ),
  );

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["name", "constraint", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousConstraint = normalizeConstraint(
        olds?.constraint ?? output?.constraint,
      );
      const nextConstraint = normalizeConstraint(
        news.constraint ?? previousConstraint,
      );
      const constraintChanged =
        previousConstraint.length > 0 &&
        nextConstraint.length > 0 &&
        previousConstraint !== nextConstraint;

      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = news.parent ?? previousParent;
      const parentChanged =
        previousParent !== undefined &&
        nextParent !== undefined &&
        !sameParent(nextParent, previousParent, env.project);

      if (constraintChanged || parentChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const constraint = normalizeConstraint(
        olds?.constraint ?? output?.constraint,
      );
      if (constraint.length === 0) return undefined;
      const parent =
        olds?.parent ?? output?.parent ?? defaultParent(env.project);
      const name = output?.name ?? resourceName(parent, constraint);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      // No labels/description — existence at (parent, constraint) is ownership.
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const policies = yield* listPolicies(defaultParent(env.project));
        return policies.map((policy) => toAttrs(policy, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const constraint = normalizeConstraint(
        news.constraint ?? output?.constraint,
      );
      const parent =
        news.parent ?? output?.parent ?? defaultParent(env.project);
      const name = output?.name ?? resourceName(parent, constraint);
      const desiredSpec = toSpec(news.spec);
      const desiredDryRun = toSpec(news.dryRunSpec);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* createPolicy(parent, {
          name: resourceName(parent, constraint),
          spec: toApiSpec(desiredSpec),
          dryRunSpec: toApiSpec(desiredDryRun),
        }).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PolicyNotResolved({ name });
      }

      const specManaged = news.spec !== undefined;
      const dryRunManaged = news.dryRunSpec !== undefined;
      const specChanged =
        specManaged && !specsEqual(toSpec(current.spec), desiredSpec);
      const dryRunChanged =
        dryRunManaged && !specsEqual(toSpec(current.dryRunSpec), desiredDryRun);

      if (specChanged || dryRunChanged) {
        const observed = current;
        const updateMask = [
          specChanged ? "spec" : undefined,
          dryRunChanged ? "dryRunSpec" : undefined,
        ]
          .filter((field): field is string => field !== undefined)
          .join(",");
        current = yield* Effect.gen(function* () {
          const latest = (yield* getByName(observed.name ?? name)) ?? observed;
          return yield* patchPolicy(
            latest.name ?? name,
            {
              name: latest.name ?? name,
              etag: latest.etag,
              spec: specManaged ? toApiSpec(desiredSpec) : latest.spec,
              dryRunSpec: dryRunManaged
                ? toApiSpec(desiredDryRun)
                : latest.dryRunSpec,
            },
            updateMask,
          );
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.exponential("200 millis"),
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deletePolicy(output.name);
    }),
  });
