import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

export interface ListApplicationsRequest extends appintegrations.ListApplicationsRequest {}

/**
 * Lists the AppIntegrations applications in the account
 * (`app-integrations:ListApplications`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListApplicationsHttp` layer on the Function to satisfy the binding.
 * ### Listing Applications
 * **Example:** List All Applications
 * ```typescript
 * // init — no resource argument (provide AWS.AppIntegrations.ListApplicationsHttp on the Function)
 * const listApplications = yield* AWS.AppIntegrations.ListApplications();
 *
 * // runtime — page through the applications in the account
 * const { Applications } = yield* listApplications({});
 * ```
 *
 * @binding
 */
export interface ListApplications extends Binding.Service<
  ListApplications,
  "AWS.AppIntegrations.ListApplications",
  () => Effect.Effect<
    (
      request?: ListApplicationsRequest,
    ) => Effect.Effect<
      appintegrations.ListApplicationsResponse,
      appintegrations.ListApplicationsError
    >
  >
> {}
export const ListApplications = Binding.Service<ListApplications>(
  "AWS.AppIntegrations.ListApplications",
);
