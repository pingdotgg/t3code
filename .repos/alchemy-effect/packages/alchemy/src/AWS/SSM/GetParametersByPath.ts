import type * as SSM from "@distilled.cloud/aws/ssm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Parameter } from "./Parameter.ts";

export interface GetParametersByPathRequest extends Omit<
  SSM.GetParametersByPathRequest,
  "Path"
> {}

/**
 * Runtime binding for `ssm:GetParametersByPath`.
 *
 * Bind this operation to a `Parameter` with a hierarchical name (e.g.
 * `/my-app/config`) to get a callable that reads every parameter stored
 * *under* that name — the bound parameter acts as the subtree root. The
 * binding grants `ssm:GetParametersByPath` on the parameter's ARN and its
 * `/*` subtree wildcard, plus `kms:Decrypt` on the bound parameter's
 * encryption key so `WithDecryption: true` works for `SecureString` children
 * encrypted with the same key.
 * @binding
 * @section Reading a Parameter Subtree
 * @example Read All Parameters Under a Path
 * ```typescript
 * const root = yield* SSM.Parameter("ConfigRoot", {
 *   name: "/my-app/config",
 *   value: "v1",
 * });
 * const getByPath = yield* SSM.GetParametersByPath(root);
 *
 * // returns /my-app/config/db-url, /my-app/config/flags/beta, …
 * const result = yield* getByPath({ Recursive: true });
 * ```
 */
export interface GetParametersByPath extends Binding.Service<
  GetParametersByPath,
  "AWS.SSM.GetParametersByPath",
  <P extends Parameter>(
    parameter: P,
  ) => Effect.Effect<
    (
      request?: GetParametersByPathRequest,
    ) => Effect.Effect<
      SSM.GetParametersByPathResult,
      SSM.GetParametersByPathError
    >
  >
> {}
export const GetParametersByPath = Binding.Service<GetParametersByPath>(
  "AWS.SSM.GetParametersByPath",
);
