import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Runtime binding for `textract:GetAdapter` — read the configuration
 * (name, feature types, auto-update, tags) of the bound adapter at
 * runtime. The grant is scoped to the adapter's ARN and the `AdapterId`
 * is injected automatically.
 *
 * @binding
 * @section Managing Adapters
 * @example Read the Bound Adapter
 * ```typescript
 * // init
 * const getAdapter = yield* AWS.Textract.GetAdapter(adapter);
 *
 * // runtime
 * const result = yield* getAdapter();
 * console.log(result.AdapterName, result.FeatureTypes);
 * ```
 */
export interface GetAdapter extends Binding.Service<
  GetAdapter,
  "AWS.Textract.GetAdapter",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<
    () => Effect.Effect<textract.GetAdapterResponse, textract.GetAdapterError>
  >
> {}
export const GetAdapter = Binding.Service<GetAdapter>(
  "AWS.Textract.GetAdapter",
);
