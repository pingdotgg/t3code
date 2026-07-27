import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Request for {@link CreateWorkspaceServiceAccountToken}. The wire field
 * `secondsToLive` is surfaced as a {@link Duration.Input} `timeToLive`.
 */
export interface CreateWorkspaceServiceAccountTokenRequest {
  /** A name for the token, unique within the service account. */
  name: string;
  /** The id of the service account to mint the token for. */
  serviceAccountId: string;
  /**
   * How long the token is valid — converted to whole seconds on the wire
   * (`secondsToLive`). Maximum 30 days.
   */
  timeToLive: Duration.Input;
}

/**
 * Runtime binding for the `CreateWorkspaceServiceAccountToken` operation
 * (IAM action `grafana:CreateWorkspaceServiceAccountToken`), scoped to one
 * {@link Workspace}.
 *
 * Mints a short-lived API token for a Grafana service account. The token
 * `key` is returned exactly once, as a `Redacted` value — use it as a
 * `Bearer` token against the workspace's Grafana HTTP API. Ideal for token
 * rotation from a scheduled Lambda. Provide the implementation with
 * `Effect.provide(AWS.Grafana.CreateWorkspaceServiceAccountTokenHttp)`.
 * @binding
 * @section Managing Service Accounts
 * @example Mint a Short-Lived Grafana API Token
 * ```typescript
 * const createToken =
 *   yield* Grafana.CreateWorkspaceServiceAccountToken(workspace);
 *
 * const { serviceAccountToken } = yield* createToken({
 *   name: "rotation-2026-07",
 *   serviceAccountId: account.id,
 *   timeToLive: "1 hour",
 * });
 * const key = Redacted.value(serviceAccountToken.key); // "glsa_..."
 * ```
 */
export interface CreateWorkspaceServiceAccountToken extends Binding.Service<
  CreateWorkspaceServiceAccountToken,
  "AWS.Grafana.CreateWorkspaceServiceAccountToken",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: CreateWorkspaceServiceAccountTokenRequest,
    ) => Effect.Effect<
      grafana.CreateWorkspaceServiceAccountTokenResponse,
      grafana.CreateWorkspaceServiceAccountTokenError
    >
  >
> {}
export const CreateWorkspaceServiceAccountToken =
  Binding.Service<CreateWorkspaceServiceAccountToken>(
    "AWS.Grafana.CreateWorkspaceServiceAccountToken",
  );
