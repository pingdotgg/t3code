import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetSecurityControlDefinition`.
 *
 * Returns the definition (title, description, parameters, severity) of a single security control.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetSecurityControlDefinitionHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Read a Control Definition
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSecurityControlDefinition = yield* AWS.SecurityHub.GetSecurityControlDefinition();
 *
 * // runtime
 * const { SecurityControlDefinition } = yield* getSecurityControlDefinition({
 *   SecurityControlId: "IAM.1",
 * });
 * ```
 */
export interface GetSecurityControlDefinition extends Binding.Service<
  GetSecurityControlDefinition,
  "AWS.SecurityHub.GetSecurityControlDefinition",
  () => Effect.Effect<
    (
      request?: securityhub.GetSecurityControlDefinitionRequest,
    ) => Effect.Effect<
      securityhub.GetSecurityControlDefinitionResponse,
      securityhub.GetSecurityControlDefinitionError
    >
  >
> {}
export const GetSecurityControlDefinition =
  Binding.Service<GetSecurityControlDefinition>(
    "AWS.SecurityHub.GetSecurityControlDefinition",
  );
