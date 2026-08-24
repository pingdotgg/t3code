import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `UpdateWorkspaceAuthentication` operation (IAM
 * action `grafana:UpdateWorkspaceAuthentication`), scoped to one
 * {@link Workspace}.
 *
 * Defines the SAML identity provider the workspace authenticates users from
 * — IdP metadata, assertion-attribute mapping, and which groups receive the
 * `Admin` and `Editor` roles. Changes can take a few minutes to apply.
 * Provide the implementation with
 * `Effect.provide(AWS.Grafana.UpdateWorkspaceAuthenticationHttp)`.
 * @binding
 * @section Managing Authentication
 * @example Configure a SAML Identity Provider
 * ```typescript
 * const updateAuth = yield* Grafana.UpdateWorkspaceAuthentication(workspace);
 *
 * yield* updateAuth({
 *   authenticationProviders: ["SAML"],
 *   samlConfiguration: {
 *     idpMetadata: { url: "https://idp.example.com/metadata.xml" },
 *     assertionAttributes: { role: "grafanaRole" },
 *     roleValues: { admin: ["platform-team"] },
 *   },
 * });
 * ```
 */
export interface UpdateWorkspaceAuthentication extends Binding.Service<
  UpdateWorkspaceAuthentication,
  "AWS.Grafana.UpdateWorkspaceAuthentication",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<
        grafana.UpdateWorkspaceAuthenticationRequest,
        "workspaceId"
      >,
    ) => Effect.Effect<
      grafana.UpdateWorkspaceAuthenticationResponse,
      grafana.UpdateWorkspaceAuthenticationError
    >
  >
> {}
export const UpdateWorkspaceAuthentication =
  Binding.Service<UpdateWorkspaceAuthentication>(
    "AWS.Grafana.UpdateWorkspaceAuthentication",
  );
