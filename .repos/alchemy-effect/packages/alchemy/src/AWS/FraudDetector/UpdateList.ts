import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { List } from "./List.ts";

/**
 * The list `name` is injected by the binding from the bound list; the caller
 * supplies the elements and the `updateMode` (`APPEND`, `REMOVE`, or
 * `REPLACE`).
 */
export interface UpdateListRequest extends Omit<
  frauddetector.UpdateListRequest,
  "name"
> {}

/**
 * Mutate the elements of a bound Amazon Fraud Detector list at runtime — the
 * effectful write call made from a deployed Lambda or Task, e.g. to append a
 * newly-confirmed fraudulent IP to a deny-list the detector's rules reference.
 *
 * Note that the `List` resource reconciles `elements` declaratively on every
 * deploy (a `REPLACE` update), so elements appended at runtime are removed by
 * the next deploy unless they are also added to the resource's props.
 *
 * @binding
 * @section Updating List Elements
 * Provide the `UpdateListHttp` implementation layer on the Function effect,
 * bind the list in the init phase, then call the returned client at runtime.
 * The binding grants `frauddetector:UpdateList` on the list and injects its
 * `name` automatically.
 *
 * @example Append from a Lambda
 * ```typescript
 * // init
 * const updateList = yield* FraudDetector.UpdateList(blockedIps);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* updateList({ elements: ["192.0.2.44"], updateMode: "APPEND" });
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.UpdateListHttp))
 * ```
 */
export interface UpdateList extends Binding.Service<
  UpdateList,
  "AWS.FraudDetector.UpdateList",
  (
    list: List,
  ) => Effect.Effect<
    (
      request: UpdateListRequest,
    ) => Effect.Effect<
      frauddetector.UpdateListResult,
      frauddetector.UpdateListError
    >
  >
> {}
export const UpdateList = Binding.Service<UpdateList>(
  "AWS.FraudDetector.UpdateList",
);
