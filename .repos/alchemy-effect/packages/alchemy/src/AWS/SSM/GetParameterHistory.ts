import type * as SSM from "@distilled.cloud/aws/ssm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Parameter } from "./Parameter.ts";

export interface GetParameterHistoryRequest extends Omit<
  SSM.GetParameterHistoryRequest,
  "Name"
> {}

/**
 * Runtime binding for `ssm:GetParameterHistory`.
 *
 * Bind this operation to a `Parameter` inside a function runtime to get a
 * callable that retrieves the change history (all versions, labels, and
 * metadata) of the bound parameter. The binding also grants `kms:Decrypt`
 * on the parameter's encryption key so `WithDecryption: true` works on
 * `SecureString` parameters.
 * @binding
 * @section Reading Parameter History
 * @example List All Versions of a Parameter
 * ```typescript
 * const getHistory = yield* SSM.GetParameterHistory(config);
 *
 * const result = yield* getHistory();
 * for (const version of result.Parameters ?? []) {
 *   yield* Effect.log(`v${version.Version}: ${version.Value}`);
 * }
 * ```
 */
export interface GetParameterHistory extends Binding.Service<
  GetParameterHistory,
  "AWS.SSM.GetParameterHistory",
  <P extends Parameter>(
    parameter: P,
  ) => Effect.Effect<
    (
      request?: GetParameterHistoryRequest,
    ) => Effect.Effect<
      SSM.GetParameterHistoryResult,
      SSM.GetParameterHistoryError
    >
  >
> {}
export const GetParameterHistory = Binding.Service<GetParameterHistory>(
  "AWS.SSM.GetParameterHistory",
);
