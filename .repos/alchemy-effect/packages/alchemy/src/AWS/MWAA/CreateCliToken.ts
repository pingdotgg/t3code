import type * as mwaa from "@distilled.cloud/aws/mwaa";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Environment } from "./Environment.ts";

/**
 * Runtime binding for `airflow:CreateCliToken`.
 *
 * Bind an {@link Environment} inside a function runtime to mint short-lived
 * (60-second) Apache Airflow CLI tokens — exchange the token against
 * `https://{WebServerHostname}/aws_mwaa/cli` to run Airflow CLI commands.
 * The `CliToken` is `Redacted` — unwrap it with `Redacted.value` when
 * building the request. Provide the implementation with
 * `Effect.provide(AWS.MWAA.CreateCliTokenHttp)`.
 * @binding
 * @section Creating CLI Tokens
 * @example Mint a CLI Token and Run an Airflow Command
 * ```typescript
 * // init — bind the operation to the environment
 * const createCliToken = yield* AWS.MWAA.CreateCliToken(environment);
 *
 * // runtime — mint a token and POST a CLI command to the webserver
 * const token = yield* createCliToken();
 * const response = yield* HttpClient.execute(
 *   HttpClientRequest.post(
 *     `https://${token.WebServerHostname}/aws_mwaa/cli`,
 *   ).pipe(
 *     HttpClientRequest.setHeader(
 *       "Authorization",
 *       `Bearer ${Redacted.value(token.CliToken!)}`,
 *     ),
 *     HttpClientRequest.bodyText("dags list -o json"),
 *   ),
 * );
 * ```
 */
export interface CreateCliToken extends Binding.Service<
  CreateCliToken,
  "AWS.MWAA.CreateCliToken",
  (
    environment: Environment,
  ) => Effect.Effect<
    () => Effect.Effect<mwaa.CreateCliTokenResponse, mwaa.CreateCliTokenError>
  >
> {}

export const CreateCliToken = Binding.Service<CreateCliToken>(
  "AWS.MWAA.CreateCliToken",
);
