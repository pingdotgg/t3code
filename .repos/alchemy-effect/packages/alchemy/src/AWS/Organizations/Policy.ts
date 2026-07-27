import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import type { ServiceControlPolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import {
  collectPages,
  createName,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type PolicyId = string;
export type PolicyArn = string;

export interface PolicyProps {
  /**
   * Policy name. If omitted, Alchemy generates one.
   */
  name?: string;
  /**
   * Policy description.
   * @default ""
   */
  description?: string;
  /**
   * Organizations policy type.
   */
  type: organizations.PolicyType;
  /**
   * Policy content. For `SERVICE_CONTROL_POLICY` / `RESOURCE_CONTROL_POLICY`
   * pass a typed {@link ServiceControlPolicyDocument} (the SCP-legal IAM
   * dialect — no `Principal`/`NotPrincipal`). Other policy types (tag,
   * backup, AI-services opt-out, ...) use their own JSON grammars — pass
   * them as a raw JSON `string`. The string form also serves as the
   * escape hatch for adopted or hand-authored documents.
   */
  document: ServiceControlPolicyDocument | string;
  /**
   * Optional tags applied to the policy.
   */
  tags?: Record<string, string>;
}

export interface Policy extends Resource<
  "AWS.Organizations.Policy",
  PolicyProps,
  {
    /**
     * ID of the policy (e.g. `p-examplepolicyid`).
     */
    policyId: PolicyId;
    /**
     * ARN of the policy.
     */
    policyArn: PolicyArn;
    /**
     * Policy name.
     */
    name: string;
    /**
     * Policy description.
     */
    description: string | undefined;
    /**
     * Organizations policy type.
     */
    type: organizations.PolicyType | undefined;
    /**
     * Whether the policy is an AWS-managed policy (e.g. `FullAWSAccess`).
     */
    awsManaged: boolean | undefined;
    /**
     * Parsed policy document as currently stored by AWS Organizations.
     */
    document: ServiceControlPolicyDocument;
    /**
     * Tags on the policy.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Organizations policy such as an SCP or tag policy.
 *
 * Attach it to a root, OU, or account with {@link PolicyAttachment}. Changing
 * `type` or `name` replaces the policy; document and description changes
 * update in place.
 * @resource
 * @section Creating Policies
 * @example Service Control Policy (Typed Document)
 * ```typescript
 * const denyLeaveOrg = yield* Policy("DenyLeaveOrg", {
 *   type: "SERVICE_CONTROL_POLICY",
 *   description: "Prevent member accounts from leaving the organization",
 *   document: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Deny",
 *         Action: ["organizations:LeaveOrganization"],
 *         Resource: "*",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Tag Policy (Raw JSON)
 * ```typescript
 * const tagPolicy = yield* Policy("RequireEnvTag", {
 *   type: "TAG_POLICY",
 *   document: JSON.stringify({
 *     tags: {
 *       environment: {
 *         tag_key: { "@@assign": "environment" },
 *         tag_value: { "@@assign": ["dev", "staging", "prod"] },
 *       },
 *     },
 *   }),
 * });
 * ```
 *
 * @section Attaching Policies
 * @example Attach an SCP to the Organization Root
 * ```typescript
 * const root = yield* Root("Root", {});
 *
 * const scpEnabled = yield* RootPolicyType("ScpEnabled", {
 *   rootId: root.rootId,
 *   policyType: "SERVICE_CONTROL_POLICY",
 * });
 *
 * yield* PolicyAttachment("DenyLeaveOrgOnRoot", {
 *   policyId: denyLeaveOrg.policyId,
 *   targetId: scpEnabled.rootId,
 * });
 * ```
 */
export const Policy = Resource<Policy>("AWS.Organizations.Policy");

export const PolicyProvider = () =>
  Provider.effect(
    Policy,
    Effect.gen(function* () {
      return {
        stables: ["policyId", "policyArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.type !== news.type) {
            return { action: "replace" } as const;
          }

          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const state = output?.policyId
            ? yield* readPolicyById(output.policyId)
            : olds
              ? yield* readPolicyByName({
                  type: olds.type,
                  name: yield* toName(id, olds),
                })
              : undefined;
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        // `listPolicies` REQUIRES a `Filter` (one policy type per call), so we
        // fan out across every policy-type filter and hydrate each summary via
        // `describePolicy` into the exact `read` shape. Degrades to `[]` when
        // the account isn't an org management/delegated-admin account
        // (`AWSOrganizationsNotInUseException`/`AccessDeniedException`) and skips
        // disabled policy types per-filter.
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* Effect.forEach(
              POLICY_TYPE_FILTERS,
              (type) =>
                retryOrganizations(
                  collectPages(
                    (NextToken) =>
                      organizations.listPolicies({ Filter: type, NextToken }),
                    (page) => page.Policies,
                  ),
                ).pipe(
                  // Not an org management/delegated account → nothing to list.
                  Effect.catchTag(
                    [
                      "AWSOrganizationsNotInUseException",
                      "AccessDeniedException",
                    ],
                    () => Effect.succeed([] as organizations.PolicySummary[]),
                  ),
                ),
              { concurrency: 10 },
            );

            const ids = summaries
              .flat()
              .map((summary) => summary.Id)
              .filter((policyId): policyId is string => policyId != null);

            const hydrated = yield* Effect.forEach(
              ids,
              (policyId) => readPolicyById(policyId),
              { concurrency: 10 },
            );

            return hydrated.filter(
              (policy): policy is Policy["Attributes"] => policy !== undefined,
            );
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const desiredDescription = news.description ?? "";
          const desiredContent =
            typeof news.document === "string"
              ? news.document
              : stringifyPolicyDocument(news.document);

          // Observe — locate the policy by ID if known, else by type+name.
          // Both `name` (after generation) and `type` are stable, so `diff`
          // handles renames as a replacement; here we just look up.
          let state = output?.policyId
            ? yield* readPolicyById(output.policyId)
            : yield* readPolicyByName({
                type: news.type,
                name,
              });

          // Ensure — create the policy if missing. Tolerate
          // `DuplicatePolicyException` as adoption (a peer reconciler beat
          // us, or our observation lost a race).
          if (!state) {
            yield* retryOrganizations(
              organizations
                .createPolicy({
                  Name: name,
                  Description: desiredDescription,
                  Type: news.type,
                  Content: desiredContent,
                })
                .pipe(
                  Effect.catchTag(
                    "DuplicatePolicyException",
                    () => Effect.void,
                  ),
                ),
            );
            state = yield* readPolicyByName({
              type: news.type,
              name,
            });
            if (!state) {
              return yield* Effect.fail(
                new Error(`policy '${name}' not found after create`),
              );
            }
          }

          // Sync description + content — diff observed cloud state against
          // desired. Documents are compared in canonical form
          // (`normalizePolicyDocument`: sorted keys, no whitespace) so an
          // unchanged re-deploy — regardless of key order or string-vs-typed
          // authoring — skips the `updatePolicy` call entirely.
          // `updatePolicy` requires `Name`; we keep the existing policy name
          // (rename triggers replacement at the diff level).
          const observedDescription = state.description ?? "";
          if (
            observedDescription !== desiredDescription ||
            normalizePolicyDocument(state.document) !==
              normalizePolicyDocument(desiredContent)
          ) {
            yield* retryOrganizations(
              organizations.updatePolicy({
                PolicyId: state.policyId,
                Name: state.name,
                Description: desiredDescription,
                Content: desiredContent,
              }),
            );
          }

          // Sync tags — diff observed cloud tags against desired. Using
          // `state.tags` (fetched fresh) keeps the reconciler convergent on
          // adoption and drift.
          const tags = yield* updateResourceTags({
            id,
            resourceId: state.policyId,
            olds: state.tags,
            news: news.tags,
          });

          const updated = yield* readPolicyById(state.policyId);
          if (!updated) {
            return yield* Effect.fail(
              new Error(`policy '${state.policyId}' not found after reconcile`),
            );
          }

          yield* session.note(updated.policyArn);
          return {
            ...updated,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations.deletePolicy({ PolicyId: output.policyId }).pipe(
              // Detaching a policy (the attachment's delete) propagates
              // asynchronously — deletePolicy issued right after the detach
              // can still observe the policy as attached. Retry through the
              // typed dependency-violation tag, bounded.
              Effect.retry({
                while: (error) => error._tag === "PolicyInUseException",
                schedule: Schedule.spaced("3 seconds"),
                times: 8,
              }),
              Effect.catchTag("PolicyNotFoundException", () => Effect.void),
            ),
          );
        }),
      };
    }),
  );

// The documented `ListPolicies` `Filter` values. `listPolicies` requires a
// single policy type per call, so `list()` fans out across all of them.
const POLICY_TYPE_FILTERS = [
  "SERVICE_CONTROL_POLICY",
  "RESOURCE_CONTROL_POLICY",
  "DECLARATIVE_POLICY_EC2",
  "BACKUP_POLICY",
  "TAG_POLICY",
  "CHATBOT_POLICY",
  "AISERVICES_OPT_OUT_POLICY",
  "SECURITYHUB_POLICY",
] as const satisfies readonly organizations.PolicyType[];

const toName = (id: string, props: { name?: string } = {}) =>
  createName(id, props.name, 128);

const readPolicyById = Effect.fn(function* (policyId: string) {
  const described = yield* retryOrganizations(
    organizations.describePolicy({ PolicyId: policyId }).pipe(
      Effect.map((response) => response.Policy),
      Effect.catchTag("PolicyNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
  );

  const summary = described?.PolicySummary;
  if (!summary?.Id || !summary.Arn || !summary.Name) {
    return undefined;
  }

  const tags = yield* readResourceTags(summary.Id).pipe(
    Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
  );

  return {
    policyId: summary.Id,
    policyArn: summary.Arn,
    name: summary.Name,
    description: summary.Description,
    type: summary.Type,
    awsManaged: summary.AwsManaged,
    document: JSON.parse(
      described?.Content ?? "{}",
    ) as ServiceControlPolicyDocument,
    tags,
  } satisfies Policy["Attributes"];
});

const readPolicyByName = Effect.fn(function* ({
  type,
  name,
}: {
  type: organizations.PolicyType;
  name: string;
}) {
  const policies = yield* retryOrganizations(
    collectPages(
      (NextToken) => organizations.listPolicies({ Filter: type, NextToken }),
      (page) => page.Policies,
    ),
  );

  const match = policies.find((policy) => policy.Name === name);
  return match?.Id ? yield* readPolicyById(match.Id) : undefined;
});
