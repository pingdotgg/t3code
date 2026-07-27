import type * as appsync from "@distilled.cloud/aws/appsync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `appsync:EvaluateMappingTemplate` — evaluate a VTL
 * request/response mapping template against a mock context without touching
 * a deployed resolver. The VTL twin of {@link EvaluateCode}, for resolvers
 * defined with `requestMappingTemplate`/`responseMappingTemplate` instead of
 * `APPSYNC_JS` code.
 *
 * An account-level operation: the binding takes no resource. Template
 * *evaluation* errors do not fail the effect — they surface on the
 * response's `error` field. Provide `AppSync.EvaluateMappingTemplateHttp`
 * on the hosting function's Effect to implement the binding.
 *
 * @binding
 * @section Evaluating Mapping Templates
 * @example Render a VTL template against a mock context
 * ```typescript
 * // init — account-level binding takes no resource
 * const evaluateTemplate = yield* AppSync.EvaluateMappingTemplate();
 *
 * // runtime
 * const result = yield* evaluateTemplate({
 *   template: `{ "sum": $util.toJson($ctx.args.a + $ctx.args.b) }`,
 *   context: JSON.stringify({ arguments: { a: 2, b: 3 } }),
 * });
 * // JSON.parse(result.evaluationResult!) → { sum: 5 }
 * ```
 */
export interface EvaluateMappingTemplate extends Binding.Service<
  EvaluateMappingTemplate,
  "AWS.AppSync.EvaluateMappingTemplate",
  () => Effect.Effect<
    (
      request: appsync.EvaluateMappingTemplateRequest,
    ) => Effect.Effect<
      appsync.EvaluateMappingTemplateResponse,
      appsync.EvaluateMappingTemplateError
    >
  >
> {}
export const EvaluateMappingTemplate = Binding.Service<EvaluateMappingTemplate>(
  "AWS.AppSync.EvaluateMappingTemplate",
);
