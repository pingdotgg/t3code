import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import { retryOrganizations } from "./common.ts";

export interface OrganizationResourcePolicyProps {
  /**
   * Typed resource policy document for the organization.
   */
  document: PolicyDocument;
}

export interface OrganizationResourcePolicy extends Resource<
  "AWS.Organizations.OrganizationResourcePolicy",
  OrganizationResourcePolicyProps,
  {
    resourcePolicyId: string;
    resourcePolicyArn: string;
    document: PolicyDocument;
  },
  never,
  Providers
> {}

/**
 * The singleton AWS Organizations resource policy.
 */
export const OrganizationResourcePolicy = Resource<OrganizationResourcePolicy>(
  "AWS.Organizations.OrganizationResourcePolicy",
);

const readResourcePolicy = () =>
  retryOrganizations(
    organizations.describeResourcePolicy({}).pipe(
      Effect.map((response) => response.ResourcePolicy),
      Effect.catchTag("ResourcePolicyNotFoundException", () =>
        Effect.succeed(undefined),
      ),
      Effect.map((policy) => {
        const summary = policy?.ResourcePolicySummary;
        return summary?.Id && summary.Arn
          ? ({
              resourcePolicyId: summary.Id,
              resourcePolicyArn: summary.Arn,
              document: JSON.parse(policy?.Content ?? "{}") as PolicyDocument,
            } satisfies OrganizationResourcePolicy["Attributes"])
          : undefined;
      }),
    ),
  );

export const OrganizationResourcePolicyProvider = () =>
  Provider.effect(
    OrganizationResourcePolicy,
    Effect.gen(function* () {
      return {
        stables: ["resourcePolicyId", "resourcePolicyArn"],
        diff: Effect.fn(function* () {}),
        read: Effect.fn(function* () {
          return yield* readResourcePolicy();
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const desiredContent = JSON.stringify(news.document);

          // Observe — fetch the live resource policy (or absence).
          let state = yield* readResourcePolicy();

          // Sync — `putResourcePolicy` is a single upsert that handles both
          // first-create and update. We diff observed content against
          // desired so the call only fires when there's drift. Reading by
          // ID isn't possible (resource is a singleton with a server-issued
          // ID), so we compare the JSON-stringified document.
          const observedContent = state
            ? JSON.stringify(state.document)
            : undefined;

          if (observedContent !== desiredContent) {
            yield* retryOrganizations(
              organizations.putResourcePolicy({
                Content: desiredContent,
              }),
            );
            state = yield* readResourcePolicy();
          }

          if (!state) {
            return yield* Effect.fail(
              new Error(
                "organization resource policy not found after reconcile",
              ),
            );
          }

          yield* session.note(state.resourcePolicyArn);
          return state;
        }),
        delete: Effect.fn(function* () {
          yield* retryOrganizations(
            organizations
              .deleteResourcePolicy({})
              .pipe(
                Effect.catchTag(
                  "ResourcePolicyNotFoundException",
                  () => Effect.void,
                ),
              ),
          );
        }),
      };
    }),
  );
