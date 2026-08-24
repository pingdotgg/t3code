import type * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListFunctionsRequest extends Lambda.ListFunctionsRequest {}

/**
 * Runtime binding for `lambda:ListFunctions`.
 *
 * An account-level binding — call it with no arguments to get a callable
 * that lists function configurations in the region. Provide the
 * `ListFunctionsHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Function Metadata
 * @example List functions in the region
 * ```typescript
 * const listFunctions = yield* AWS.Lambda.ListFunctions();
 *
 * const response = yield* listFunctions({ MaxItems: 50 });
 * const names = response.Functions?.map((f) => f.FunctionName);
 * ```
 */
export interface ListFunctions extends Binding.Service<
  ListFunctions,
  "AWS.Lambda.ListFunctions",
  () => Effect.Effect<
    (
      request?: ListFunctionsRequest,
    ) => Effect.Effect<Lambda.ListFunctionsResponse, Lambda.ListFunctionsError>
  >
> {}
export const ListFunctions = Binding.Service<ListFunctions>(
  "AWS.Lambda.ListFunctions",
);
