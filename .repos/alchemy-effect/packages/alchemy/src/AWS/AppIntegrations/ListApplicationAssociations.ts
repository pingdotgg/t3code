import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface ListApplicationAssociationsRequest extends Omit<
  appintegrations.ListApplicationAssociationsRequest,
  "ApplicationId"
> {}

/**
 * Lists the associations of an AppIntegrations {@link Application} — the
 * Amazon Connect instances (or other clients) the application has been
 * associated with (`app-integrations:ListApplicationAssociations`).
 *
 * Provide the `ListApplicationAssociationsHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Listing Application Associations
 * @example List an Application's Associations
 * ```typescript
 * // init (provide AWS.AppIntegrations.ListApplicationAssociationsHttp on the Function)
 * const listApplicationAssociations =
 *   yield* AWS.AppIntegrations.ListApplicationAssociations(application);
 *
 * // runtime — the ApplicationId is injected automatically
 * const { ApplicationAssociations } = yield* listApplicationAssociations();
 * ```
 */
export interface ListApplicationAssociations extends Binding.Service<
  ListApplicationAssociations,
  "AWS.AppIntegrations.ListApplicationAssociations",
  <R extends Application>(
    application: R,
  ) => Effect.Effect<
    (
      request?: ListApplicationAssociationsRequest,
    ) => Effect.Effect<
      appintegrations.ListApplicationAssociationsResponse,
      appintegrations.ListApplicationAssociationsError
    >
  >
> {}
export const ListApplicationAssociations =
  Binding.Service<ListApplicationAssociations>(
    "AWS.AppIntegrations.ListApplicationAssociations",
  );
