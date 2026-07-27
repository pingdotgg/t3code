import type * as mwaa from "@distilled.cloud/aws/mwaa";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AirflowRoleOptions } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";

/**
 * Runtime binding for `airflow:CreateWebLoginToken`.
 *
 * Bind an {@link Environment} inside a function runtime to mint short-lived
 * Apache Airflow web login tokens — exchange the token against
 * `https://{WebServerHostname}/aws_mwaa/aws-console-sso` to open an
 * authenticated Airflow UI session. The IAM grant is scoped to the Airflow
 * RBAC role the session is mapped to (`Admin` by default — pass
 * `{ airflowRole }` to scope it down). The `WebToken` is `Redacted` — unwrap
 * it with `Redacted.value`. Provide the implementation with
 * `Effect.provide(AWS.MWAA.CreateWebLoginTokenHttp)`.
 * @binding
 * @section Creating Web Login Tokens
 * @example Mint a Web Login Token
 * ```typescript
 * // init — bind the operation to the environment (Admin session)
 * const createWebLoginToken = yield* AWS.MWAA.CreateWebLoginToken(environment);
 *
 * // runtime — mint a token and build the SSO login URL
 * const token = yield* createWebLoginToken();
 * const loginUrl =
 *   `https://${token.WebServerHostname}/aws_mwaa/aws-console-sso` +
 *   `?login=true#${Redacted.value(token.WebToken!)}`;
 * ```
 *
 * @example Scope the Session to a Read-Only Airflow Role
 * ```typescript
 * const createViewerToken = yield* AWS.MWAA.CreateWebLoginToken(environment, {
 *   airflowRole: "Viewer",
 * });
 * ```
 */
export interface CreateWebLoginToken extends Binding.Service<
  CreateWebLoginToken,
  "AWS.MWAA.CreateWebLoginToken",
  (
    environment: Environment,
    options?: AirflowRoleOptions,
  ) => Effect.Effect<
    () => Effect.Effect<
      mwaa.CreateWebLoginTokenResponse,
      mwaa.CreateWebLoginTokenError
    >
  >
> {}

export const CreateWebLoginToken = Binding.Service<CreateWebLoginToken>(
  "AWS.MWAA.CreateWebLoginToken",
);
