import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { List } from "./List.ts";

/**
 * The list `name` is injected by the binding from the bound list; only the
 * pagination controls remain.
 */
export interface GetListElementsRequest extends Omit<
  frauddetector.GetListElementsRequest,
  "name"
> {}

/**
 * Read the elements of a bound Amazon Fraud Detector list — the effectful
 * lookup call made from a deployed Lambda or Task, e.g. to check an incoming
 * value against a deny-list outside of a detector evaluation.
 *
 * Elements decode as sensitive values (`string | Redacted<string>`); unwrap
 * with `Redacted.value` where needed.
 *
 * @binding
 * @section Reading List Elements
 * Provide the `GetListElementsHttp` implementation layer on the Function
 * effect, bind the list in the init phase, then call the returned client at
 * runtime. The binding grants `frauddetector:GetListElements` on the list and
 * injects its `name` automatically.
 *
 * @example Read from a Lambda
 * ```typescript
 * // init
 * const getListElements = yield* FraudDetector.GetListElements(blockedIps);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { elements } = yield* getListElements({});
 *     return HttpServerResponse.json({ count: elements?.length ?? 0 });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.GetListElementsHttp))
 * ```
 */
export interface GetListElements extends Binding.Service<
  GetListElements,
  "AWS.FraudDetector.GetListElements",
  (
    list: List,
  ) => Effect.Effect<
    (
      request: GetListElementsRequest,
    ) => Effect.Effect<
      frauddetector.GetListElementsResult,
      frauddetector.GetListElementsError
    >
  >
> {}
export const GetListElements = Binding.Service<GetListElements>(
  "AWS.FraudDetector.GetListElements",
);
