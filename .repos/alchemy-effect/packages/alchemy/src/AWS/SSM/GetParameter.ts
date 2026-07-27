import type * as SSM from "@distilled.cloud/aws/ssm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Parameter } from "./Parameter.ts";

export interface GetParameterRequest extends Omit<
  SSM.GetParameterRequest,
  "Name"
> {}

/**
 * Runtime binding for `ssm:GetParameter`.
 *
 * Bind this operation to a `Parameter` inside a function runtime to get a
 * callable that automatically injects the parameter name. For `SecureString`
 * parameters the binding also grants `kms:Decrypt` on the parameter's
 * encryption key so `WithDecryption: true` works out of the box.
 * @binding
 * @section Reading a Parameter
 * @example Read a String Parameter
 * ```typescript
 * const getParameter = yield* SSM.GetParameter(config);
 *
 * const result = yield* getParameter();
 * const value = result.Parameter?.Value;
 * ```
 *
 * @example Read a SecureString Parameter with Decryption
 * ```typescript
 * const getSecret = yield* SSM.GetParameter(apiKey);
 *
 * const result = yield* getSecret({ WithDecryption: true });
 * ```
 */
export interface GetParameter extends Binding.Service<
  GetParameter,
  "AWS.SSM.GetParameter",
  <P extends Parameter>(
    parameter: P,
  ) => Effect.Effect<
    (
      request?: GetParameterRequest,
    ) => Effect.Effect<SSM.GetParameterResult, SSM.GetParameterError>
  >
> {}
export const GetParameter = Binding.Service<GetParameter>(
  "AWS.SSM.GetParameter",
);
