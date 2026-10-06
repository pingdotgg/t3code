import * as iam from "@distilled.cloud/gcp/iam_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  attachmentPointOf,
  denypoliciesParent,
  hasOwnershipAnnotations,
  ownedByAlchemy,
  parsePolicyName,
  policyName,
  ResourceNotResolved,
  toPolicyId,
  waitForDeleteOperation,
  waitForOperation,
} from "./internal.ts";

export type DenyRuleCondition = {
  /** CEL expression. Resource-tag functions only. */
  expression?: string;
  /** Short title. */
  title?: string;
  /** Longer description. */
  description?: string;
  /** Location string for error reporting. */
  location?: string;
};

export type DenyRule = {
  /**
   * Permissions denied (`{service_fqdn}/{resource}.{verb}`).
   */
  deniedPermissions?: string[];
  /**
   * Permissions excluded from `deniedPermissions`.
   */
  exceptionPermissions?: string[];
  /**
   * Identities denied the permissions.
   */
  deniedPrincipals?: string[];
  /**
   * Identities excluded from `deniedPrincipals`.
   */
  exceptionPrincipals?: string[];
  /**
   * CEL condition that selects when this rule applies.
   */
  denialCondition?: DenyRuleCondition;
};

export type PolicyRule = {
  /**
   * User-specified description (max 256 characters).
   */
  description?: string;
  /**
   * Deny rule.
   */
  denyRule?: DenyRule;
};

export type PolicyProps = {
  /**
   * Attachment point, URL-encoded (`cloudresourcemanager.googleapis.com%2Fprojects%2Fmy-project`)
   * or raw (`cloudresourcemanager.googleapis.com/projects/my-project`).
   * Defaults to the current GCP project. Immutable — changing it
   * replaces the policy.
   */
  attachmentPoint?: string;
  /**
   * Policy id (3-63 chars, lowercase letters, numbers, dashes, periods;
   * must start with a letter). If omitted, a unique name is generated.
   * Immutable — changing it replaces the policy.
   */
  policyId?: string;
  /**
   * Display name (max 63 characters).
   */
  displayName?: string;
  /**
   * User annotations. Alchemy ownership annotations are merged in
   * automatically (`alchemy-stack` / `alchemy-stage` / `alchemy-id`).
   */
  annotations?: Record<string, string>;
  /**
   * Deny rules. Defaults to a no-op deny of a non-existent principal so
   * create is valid without locking anyone out.
   */
  rules?: PolicyRule[];
};

export type Policy = Resource<
  "GCP.IAM.Policy",
  PolicyProps,
  {
    /** Full resource name `policies/{attachment}/denypolicies/{policy}`. */
    name: string;
    /** Policy id. */
    policyId: string;
    /** URL-encoded attachment point. */
    attachmentPoint: string;
    /** Display name. */
    displayName: string | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** Kind (`DenyPolicy`). */
    kind: string | undefined;
    /** Globally unique uid. */
    uid: string | undefined;
    /** Etag. */
    etag: string | undefined;
    /** Rules. */
    rules: PolicyRule[] | undefined;
    /** RFC3339 create time. */
    createTime: string | undefined;
    /** RFC3339 update time. */
    updateTime: string | undefined;
    /** RFC3339 delete time when deleted. */
    deleteTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An IAM v2 deny policy attached to a project, folder, or organization.
 *
 * This is not {@link GCP.OrgPolicy.Policy} (organization policy
 * constraints). Deny policies use annotations for Alchemy ownership.
 * Create, update, and delete are long-running operations.
 *
 * ### Creating a Deny Policy
 * **Example:** Generated id on this project
 * ```typescript
 * const policy = yield* GCP.IAM.Policy("Probe", {
 *   displayName: "alchemy-probe",
 *   rules: [{
 *     denyRule: {
 *       deniedPermissions: ["iam.googleapis.com/roles.list"],
 *       deniedPrincipals: [
 *         "principal://goog/subject/alchemy-deny-probe@example.invalid",
 *       ],
 *     },
 *   }],
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export const Policy = Resource<Policy>("GCP.IAM.Policy");

export class PolicyNotResolved extends Data.TaggedError(
  "GCP.IAM.PolicyNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_RULE: PolicyRule = {
  description: "alchemy ownership probe",
  denyRule: {
    deniedPermissions: ["iam.googleapis.com/roles.list"],
    deniedPrincipals: [
      "principal://goog/subject/alchemy-deny-probe@example.invalid",
    ],
  },
};

const ruleOf = (rule: iam.GoogleIamV2PolicyRule | PolicyRule): PolicyRule => ({
  description: rule.description,
  denyRule: rule.denyRule
    ? {
        deniedPermissions: rule.denyRule.deniedPermissions,
        exceptionPermissions: rule.denyRule.exceptionPermissions,
        deniedPrincipals: rule.denyRule.deniedPrincipals,
        exceptionPrincipals: rule.denyRule.exceptionPrincipals,
        denialCondition: rule.denyRule.denialCondition,
      }
    : undefined,
});

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

const toAttrs = (policy: iam.GoogleIamV2Policy) => {
  const name = policy.name ?? "";
  const parsed = parsePolicyName(name);
  return {
    name,
    policyId: parsed.policyId,
    attachmentPoint: parsed.attachmentPoint,
    displayName: policy.displayName,
    annotations: stripInternalLabels(tagRecord(policy.annotations)),
    kind: policy.kind,
    uid: policy.uid,
    etag: policy.etag,
    rules: policy.rules?.map(ruleOf),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
    deleteTime: policy.deleteTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : iam.getPolicies({ name }).pipe(
        Effect.map((policy) => (policy.deleteTime ? undefined : policy)),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

const listAt = (parent: string) =>
  iam.listPoliciesPolicies.pages({ parent, pageSize: 1000 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.policies ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as iam.GoogleIamV2Policy[]),
    ),
  );

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["name", "policyId", "attachmentPoint", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPoint = olds?.attachmentPoint ?? output?.attachmentPoint;
      const previousId = olds?.policyId ?? output?.policyId;
      if (
        (previousPoint !== undefined &&
          news.attachmentPoint !== undefined &&
          attachmentPointOf("x", news.attachmentPoint) !==
            attachmentPointOf("x", previousPoint)) ||
        (previousId !== undefined &&
          news.policyId !== undefined &&
          news.policyId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const attachmentPoint = attachmentPointOf(
        env.project,
        olds?.attachmentPoint ?? output?.attachmentPoint,
      );
      const policyId = yield* toPolicyId(id, olds?.policyId, output?.policyId);
      const name = output?.name ?? policyName(attachmentPoint, policyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.annotations))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parent = denypoliciesParent(attachmentPointOf(env.project));
        const policies = yield* listAt(parent);
        const named = yield* Effect.forEach(
          policies,
          (policy) =>
            policy.name ? getByName(policy.name) : Effect.succeed(undefined),
          { concurrency: 4 },
        );
        return named
          .filter(
            (policy): policy is iam.GoogleIamV2Policy =>
              policy !== undefined &&
              hasOwnershipAnnotations(policy.annotations),
          )
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const attachmentPoint = attachmentPointOf(
        env.project,
        news.attachmentPoint ?? output?.attachmentPoint,
      );
      const policyId = yield* toPolicyId(id, news.policyId, output?.policyId);
      const name = policyName(attachmentPoint, policyId);
      const parent = denypoliciesParent(attachmentPoint);
      const desiredAnnotations = {
        ...toLabels(news.annotations),
        ...(yield* createInternalLabels(id)),
      };
      const rules = (news.rules ?? [DEFAULT_RULE]).map(ruleOf);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* iam
          .createPolicyPolicies({
            parent,
            policyId,
            body: {
              displayName: news.displayName,
              annotations: desiredAnnotations,
              rules,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(name).pipe(
                Effect.map((policy) =>
                  policy
                    ? ({
                        done: true,
                        response: { name: policy.name },
                      } satisfies iam.GoogleLongrunningOperation)
                    : undefined,
                ),
              ),
            ),
          );
        if (created) {
          yield* waitForOperation(created);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observed = tagRecord(current.annotations);
      const { upsert, removed } = diffLabels(observed, desiredAnnotations);
      const annotationsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged =
        news.displayName !== undefined &&
        (current.displayName ?? "") !== news.displayName;
      const rulesChanged = jsonOf(current.rules?.map(ruleOf)) !== jsonOf(rules);

      if (annotationsChanged || displayChanged || rulesChanged) {
        const updated = yield* iam.updatePolicies({
          name: current.name ?? name,
          body: {
            etag: current.etag,
            displayName: news.displayName ?? current.displayName,
            annotations: desiredAnnotations,
            rules,
          },
        });
        yield* waitForOperation(updated);
        current = (yield* getByName(current.name ?? name)) ?? current;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* iam
        .deletePolicies({ name: output.name, etag: output.etag })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation) {
        yield* waitForDeleteOperation(operation);
      }
    }),
  });
