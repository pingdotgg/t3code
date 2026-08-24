import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `ListWorkspaceServiceAccountTokens` operation
 * (IAM action `grafana:ListWorkspaceServiceAccountTokens`), scoped to one
 * {@link Workspace}.
 *
 * Lists the API tokens of a Grafana service account (metadata only — the
 * secret key is only returned at mint time). Provide the implementation with
 * `Effect.provide(AWS.Grafana.ListWorkspaceServiceAccountTokensHttp)`.
 * @binding
 * @section Managing Service Accounts
 * @example Find Expired Tokens to Revoke
 * ```typescript
 * const listTokens =
 *   yield* Grafana.ListWorkspaceServiceAccountTokens(workspace);
 *
 * const { serviceAccountTokens } = yield* listTokens({
 *   serviceAccountId: account.id,
 * });
 * const expired = serviceAccountTokens.filter(
 *   (token) => token.expiresAt.getTime() < Date.now(),
 * );
 * ```
 */
export interface ListWorkspaceServiceAccountTokens extends Binding.Service<
  ListWorkspaceServiceAccountTokens,
  "AWS.Grafana.ListWorkspaceServiceAccountTokens",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<
        grafana.ListWorkspaceServiceAccountTokensRequest,
        "workspaceId"
      >,
    ) => Effect.Effect<
      grafana.ListWorkspaceServiceAccountTokensResponse,
      grafana.ListWorkspaceServiceAccountTokensError
    >
  >
> {}
export const ListWorkspaceServiceAccountTokens =
  Binding.Service<ListWorkspaceServiceAccountTokens>(
    "AWS.Grafana.ListWorkspaceServiceAccountTokens",
  );
