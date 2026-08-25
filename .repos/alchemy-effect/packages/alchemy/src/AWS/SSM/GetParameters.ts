import type * as SSM from "@distilled.cloud/aws/ssm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Parameter } from "./Parameter.ts";

export interface GetParametersRequest extends Omit<
  SSM.GetParametersRequest,
  "Names"
> {}

export type GetParametersParameters = [Parameter, ...Parameter[]];

/**
 * Runtime binding for `ssm:GetParameters`.
 *
 * Bind this operation to one or more `Parameter`s inside a function runtime
 * to get a callable that fetches all of them in a single API call. The
 * binding grants `ssm:GetParameters` on the exact parameter ARNs and
 * `kms:Decrypt` on the encryption keys of any `SecureString` parameters.
 * @binding
 * @section Reading Multiple Parameters
 * @example Read Several Parameters at Once
 * ```typescript
 * const getParameters = yield* SSM.GetParameters(dbUrl, apiKey);
 *
 * const result = yield* getParameters({ WithDecryption: true });
 * for (const parameter of result.Parameters ?? []) {
 *   yield* Effect.log(`${parameter.Name} = ${parameter.Value}`);
 * }
 * ```
 */
export interface GetParameters extends Binding.Service<
  GetParameters,
  "AWS.SSM.GetParameters",
  (
    ...parameters: GetParametersParameters
  ) => Effect.Effect<
    (
      request?: GetParametersRequest,
    ) => Effect.Effect<SSM.GetParametersResult, SSM.GetParametersError>
  >
> {}
export const GetParameters = Binding.Service<GetParameters>(
  "AWS.SSM.GetParameters",
);
