import type * as appsync from "@distilled.cloud/aws/appsync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `appsync:EvaluateCode` — evaluate `APPSYNC_JS`
 * resolver/function code against a mock context without touching a deployed
 * resolver. Useful for CI/tooling functions that validate resolver code
 * before it ships.
 *
 * An account-level operation: the binding takes no resource. GraphQL
 * *evaluation* errors do not fail the effect — they surface on the
 * response's `error` field. Provide `AppSync.EvaluateCodeHttp` on the
 * hosting function's Effect to implement the binding.
 *
 * @binding
 * @section Evaluating Resolver Code
 * @example Run a resolver's request function against a mock context
 * ```typescript
 * // init — account-level binding takes no resource
 * const evaluateCode = yield* AppSync.EvaluateCode();
 *
 * // runtime
 * const result = yield* evaluateCode({
 *   runtime: AppSync.APPSYNC_JS,
 *   code: `
 *     export function request(ctx) { return { payload: ctx.args.a + ctx.args.b }; }
 *     export function response(ctx) { return ctx.result; }
 *   `,
 *   context: JSON.stringify({ arguments: { a: 2, b: 3 } }),
 *   function: "request",
 * });
 * // JSON.parse(result.evaluationResult!) → { payload: 5 }
 * ```
 */
export interface EvaluateCode extends Binding.Service<
  EvaluateCode,
  "AWS.AppSync.EvaluateCode",
  () => Effect.Effect<
    (
      request: appsync.EvaluateCodeRequest,
    ) => Effect.Effect<appsync.EvaluateCodeResponse, appsync.EvaluateCodeError>
  >
> {}
export const EvaluateCode = Binding.Service<EvaluateCode>(
  "AWS.AppSync.EvaluateCode",
);
