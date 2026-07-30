import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface DelegatedAdministratorProps {
  /**
   * Member account registered as delegated administrator.
   */
  accountId: string;
  /**
   * Service principal delegated to the account.
   */
  servicePrincipal: string;
}

export interface DelegatedAdministrator extends Resource<
  "AWS.Organizations.DelegatedAdministrator",
  DelegatedAdministratorProps,
  {
    /**
     * 12-digit ID of the delegated administrator account.
     */
    accountId: string;
    /**
     * ARN of the delegated administrator account.
     */
    accountArn: string | undefined;
    /**
     * Friendly name of the delegated administrator account.
     */
    accountName: organizations.DelegatedAdministrator["Name"] | undefined;
    /**
     * Email address of the delegated administrator account.
     */
    accountEmail: organizations.DelegatedAdministrator["Email"] | undefined;
    /**
     * Service principal delegated to the account.
     */
    servicePrincipal: string;
    /**
     * When the delegation was enabled.
     */
    delegationEnabledDate: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * Registers a member {@link Account} as the delegated administrator for a
 * trusted AWS service, letting that account manage the service org-wide
 * instead of the management account.
 *
 * Requires trusted access for the same service principal (see
 * {@link TrustedServiceAccess}). Existence-only resource: changing
 * `accountId` or `servicePrincipal` replaces the registration.
 * @resource
 * @section Delegating Administration
 * @example Delegate GuardDuty to a Security Account
 * ```typescript
 * const security = yield* Account("Security", {
 *   name: "security",
 *   email: "aws-security@example.com",
 *   parentId: root.rootId,
 * });
 *
 * const guardDutyAccess = yield* TrustedServiceAccess("GuardDutyAccess", {
 *   servicePrincipal: "guardduty.amazonaws.com",
 * });
 *
 * yield* DelegatedAdministrator("GuardDutyAdmin", {
 *   accountId: security.accountId,
 *   servicePrincipal: guardDutyAccess.servicePrincipal,
 * });
 * ```
 */
export const DelegatedAdministrator = Resource<DelegatedAdministrator>(
  "AWS.Organizations.DelegatedAdministrator",
);

export const DelegatedAdministratorProvider = () =>
  Provider.effect(
    DelegatedAdministrator,
    Effect.gen(function* () {
      return {
        stables: ["accountId", "servicePrincipal"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.accountId !== news.accountId ||
            olds?.servicePrincipal !== news.servicePrincipal
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const accountId = output?.accountId ?? olds?.accountId;
          const servicePrincipal =
            output?.servicePrincipal ?? olds?.servicePrincipal;
          if (accountId === undefined || servicePrincipal === undefined) {
            // Output-valued props don't survive a `creating`-state round-trip
            // (they deserialize as `undefined`) — report "not found" so the
            // engine re-drives the create.
            return undefined;
          }
          return yield* readDelegatedAdministrator({
            accountId,
            servicePrincipal,
          });
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate every delegated administrator account in the org. If
            // this account isn't an org management account (or lacks access),
            // Organizations enumeration isn't available here — return [].
            const admins = yield* retryOrganizations(
              collectPages(
                (NextToken) =>
                  organizations.listDelegatedAdministrators({ NextToken }),
                (page) => page.DelegatedAdministrators,
              ),
            ).pipe(
              Effect.catchTags({
                AWSOrganizationsNotInUseException: () =>
                  Effect.succeed<organizations.DelegatedAdministrator[]>([]),
                AccessDeniedException: () =>
                  Effect.succeed<organizations.DelegatedAdministrator[]>([]),
                UnsupportedAPIEndpointException: () =>
                  Effect.succeed<organizations.DelegatedAdministrator[]>([]),
              }),
            );

            // Fan out: each admin account may be delegated for multiple
            // services. The canonical `read` shape is one item per
            // (account, servicePrincipal), so expand each account into one
            // Attributes per delegated service.
            const rows = yield* Effect.forEach(
              admins.filter(
                (
                  admin,
                ): admin is organizations.DelegatedAdministrator & {
                  Id: string;
                } => admin.Id != null,
              ),
              (admin) =>
                retryOrganizations(
                  collectPages(
                    (NextToken) =>
                      organizations.listDelegatedServicesForAccount({
                        AccountId: admin.Id,
                        NextToken,
                      }),
                    (page) => page.DelegatedServices,
                  ),
                ).pipe(
                  // The account may be deregistered between the two calls — skip.
                  Effect.catchTags({
                    AccountNotFoundException: () =>
                      Effect.succeed<organizations.DelegatedService[]>([]),
                    AccountNotRegisteredException: () =>
                      Effect.succeed<organizations.DelegatedService[]>([]),
                  }),
                  Effect.map((services) =>
                    services
                      .filter(
                        (
                          service,
                        ): service is organizations.DelegatedService & {
                          ServicePrincipal: string;
                        } => service.ServicePrincipal != null,
                      )
                      .map(
                        (service) =>
                          ({
                            accountId: admin.Id,
                            accountArn: admin.Arn,
                            accountName: admin.Name,
                            accountEmail: admin.Email,
                            servicePrincipal: service.ServicePrincipal,
                            delegationEnabledDate:
                              service.DelegationEnabledDate ??
                              admin.DelegationEnabledDate,
                          }) satisfies DelegatedAdministrator["Attributes"],
                      ),
                  ),
                ),
              { concurrency: 10 },
            );

            return rows.flat();
          }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — look up the live delegation. Replacement-only props
          // (`accountId`, `servicePrincipal`) mean the diff handles identity
          // changes; we just check whether the registration exists.
          let state = yield* readDelegatedAdministrator(news);

          // Ensure — register if missing. Tolerate
          // `AccountAlreadyRegisteredException` for idempotency under races
          // between observe and register.
          if (!state) {
            yield* retryOrganizations(
              organizations
                .registerDelegatedAdministrator({
                  AccountId: news.accountId,
                  ServicePrincipal: news.servicePrincipal,
                })
                .pipe(
                  Effect.catchTag(
                    "AccountAlreadyRegisteredException",
                    () => Effect.void,
                  ),
                ),
            );
            state = yield* readDelegatedAdministrator(news);
            if (!state) {
              return yield* Effect.fail(
                new Error(
                  `delegated administrator '${news.accountId}' for '${news.servicePrincipal}' not found after create`,
                ),
              );
            }
          }

          yield* session.note(`${state.accountId}:${state.servicePrincipal}`);
          return state;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (
            !(yield* readDelegatedAdministrator({
              accountId: output.accountId,
              servicePrincipal: output.servicePrincipal,
            }))
          ) {
            return;
          }

          yield* retryOrganizations(
            organizations.deregisterDelegatedAdministrator({
              AccountId: output.accountId,
              ServicePrincipal: output.servicePrincipal,
            }),
          );
        }),
      };
    }),
  );

const readDelegatedAdministrator = Effect.fn(function* ({
  accountId,
  servicePrincipal,
}: DelegatedAdministratorProps) {
  const [delegatedServices, delegatedAdmins] = yield* Effect.all([
    retryOrganizations(
      collectPages(
        (NextToken) =>
          organizations.listDelegatedServicesForAccount({
            AccountId: accountId,
            NextToken,
          }),
        (page) => page.DelegatedServices,
      ),
    ),
    retryOrganizations(
      collectPages(
        (NextToken) =>
          organizations.listDelegatedAdministrators({
            ServicePrincipal: servicePrincipal,
            NextToken,
          }),
        (page) => page.DelegatedAdministrators,
      ),
    ),
  ]);

  const service = delegatedServices.find(
    (candidate) => candidate.ServicePrincipal === servicePrincipal,
  );
  const account = delegatedAdmins.find(
    (candidate) => candidate.Id === accountId,
  );

  return service && account
    ? ({
        accountId,
        accountArn: account.Arn,
        accountName: account.Name,
        accountEmail: account.Email,
        servicePrincipal,
        delegationEnabledDate:
          service.DelegationEnabledDate ?? account.DelegationEnabledDate,
      } satisfies DelegatedAdministrator["Attributes"])
    : undefined;
});
