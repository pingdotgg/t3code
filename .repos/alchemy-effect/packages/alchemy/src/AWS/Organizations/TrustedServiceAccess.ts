import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface TrustedServiceAccessProps {
  /**
   * Service principal granted trusted access to the organization.
   */
  servicePrincipal: string;
}

export interface TrustedServiceAccess extends Resource<
  "AWS.Organizations.TrustedServiceAccess",
  TrustedServiceAccessProps,
  {
    servicePrincipal: string;
    dateEnabled: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables trusted access for an AWS service principal.
 */
export const TrustedServiceAccess = Resource<TrustedServiceAccess>(
  "AWS.Organizations.TrustedServiceAccess",
);

export const TrustedServiceAccessProvider = () =>
  Provider.effect(
    TrustedServiceAccess,
    Effect.gen(function* () {
      return {
        stables: ["servicePrincipal"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.servicePrincipal !== news.servicePrincipal) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readTrustedServiceAccess(
            output?.servicePrincipal ?? olds!.servicePrincipal,
          );
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — fetch live trusted-access state. We never trust prior
          // `output` blindly; if access was disabled out-of-band we re-enable.
          let state = yield* readTrustedServiceAccess(news.servicePrincipal);

          // Ensure — enable trusted access if it's missing. This API is
          // effectively idempotent for already-enabled principals, but we
          // gate the call to avoid unnecessary churn.
          if (!state) {
            yield* retryOrganizations(
              organizations.enableAWSServiceAccess({
                ServicePrincipal: news.servicePrincipal,
              }),
            );
            state = yield* readTrustedServiceAccess(news.servicePrincipal);
            if (!state) {
              return yield* Effect.fail(
                new Error(
                  `trusted service access '${news.servicePrincipal}' not found after create`,
                ),
              );
            }
          }

          yield* session.note(state.servicePrincipal);
          return state;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!(yield* readTrustedServiceAccess(output.servicePrincipal))) {
            return;
          }

          yield* retryOrganizations(
            organizations.disableAWSServiceAccess({
              ServicePrincipal: output.servicePrincipal,
            }),
          );
        }),
      };
    }),
  );

const readTrustedServiceAccess = Effect.fn(function* (
  servicePrincipal: string,
) {
  const principals = yield* retryOrganizations(
    collectPages(
      (NextToken) =>
        organizations.listAWSServiceAccessForOrganization({ NextToken }),
      (page) => page.EnabledServicePrincipals,
    ),
  );

  const match = principals.find(
    (candidate) => candidate.ServicePrincipal === servicePrincipal,
  );

  return match
    ? ({
        servicePrincipal,
        dateEnabled: match.DateEnabled,
      } satisfies TrustedServiceAccess["Attributes"])
    : undefined;
});
