import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListSecurityControlDefinitions`.
 *
 * Lists all security control definitions, optionally restricted to one standard.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListSecurityControlDefinitionsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example List Control Definitions
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSecurityControlDefinitions = yield* AWS.SecurityHub.ListSecurityControlDefinitions();
 *
 * // runtime
 * const { SecurityControlDefinitions } = yield* listSecurityControlDefinitions();
 * ```
 */
export interface ListSecurityControlDefinitions extends Binding.Service<
  ListSecurityControlDefinitions,
  "AWS.SecurityHub.ListSecurityControlDefinitions",
  () => Effect.Effect<
    (
      request?: securityhub.ListSecurityControlDefinitionsRequest,
    ) => Effect.Effect<
      securityhub.ListSecurityControlDefinitionsResponse,
      securityhub.ListSecurityControlDefinitionsError
    >
  >
> {}
export const ListSecurityControlDefinitions =
  Binding.Service<ListSecurityControlDefinitions>(
    "AWS.SecurityHub.ListSecurityControlDefinitions",
  );
