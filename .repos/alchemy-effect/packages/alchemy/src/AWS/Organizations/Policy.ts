import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
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
   * Typed policy document.
   */
  document: PolicyDocument;
  /**
   * Optional tags applied to the policy.
   */
  tags?: Record<string, string>;
}

export interface Policy extends Resource<
  "AWS.Organizations.Policy",
  PolicyProps,
  {
    policyId: PolicyId;
    policyArn: PolicyArn;
    name: string;
    description: string | undefined;
    type: organizations.PolicyType | undefined;
    awsManaged: boolean | undefined;
    document: PolicyDocument;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Organizations policy such as an SCP or tag policy.
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
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const desiredDescription = news.description ?? "";
          const desiredContent = JSON.stringify(news.document);

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
          // desired. `updatePolicy` requires `Name`; we keep the existing
          // policy name (rename triggers replacement at the diff level).
          const observedDescription = state.description ?? "";
          const observedContent = JSON.stringify(state.document);
          if (
            observedDescription !== desiredDescription ||
            observedContent !== desiredContent
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
            organizations
              .deletePolicy({ PolicyId: output.policyId })
              .pipe(
                Effect.catchTag("PolicyNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

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
    document: JSON.parse(described?.Content ?? "{}") as PolicyDocument,
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
