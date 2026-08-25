import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for `transfer:TestIdentityProvider`.
 *
 * Exercises the bound {@link Server}'s custom identity provider
 * (`API_GATEWAY`, `AWS_LAMBDA`, or `AWS_DIRECTORY_SERVICE`) with a user
 * name and optional password, returning the provider's raw response and
 * status code — the `ServerId` is injected from the binding. The password
 * is `Redacted` end-to-end (distilled marks `UserPassword` sensitive).
 * Calling it on a `SERVICE_MANAGED` server fails with the typed
 * `InvalidRequestException`. Provide the implementation with
 * `Effect.provide(AWS.Transfer.TestIdentityProviderHttp)`.
 * @binding
 * @section Diagnosing Authentication
 * @example Test a User's Credentials
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // init — bind the operation to the server
 * const testIdentityProvider = yield* AWS.Transfer.TestIdentityProvider(server);
 *
 * // runtime
 * const result = yield* testIdentityProvider({
 *   UserName: "alice",
 *   UserPassword: Redacted.make("secret"),
 *   ServerProtocol: "SFTP",
 * });
 * yield* Effect.log(`identity provider replied ${result.StatusCode}`);
 * ```
 */
export interface TestIdentityProvider extends Binding.Service<
  TestIdentityProvider,
  "AWS.Transfer.TestIdentityProvider",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: Omit<transfer.TestIdentityProviderRequest, "ServerId">,
    ) => Effect.Effect<
      transfer.TestIdentityProviderResponse,
      transfer.TestIdentityProviderError
    >
  >
> {}
export const TestIdentityProvider = Binding.Service<TestIdentityProvider>(
  "AWS.Transfer.TestIdentityProvider",
);
