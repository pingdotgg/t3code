import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Runtime binding for `textract:DeleteAdapterVersion` — delete a version
 * of the bound adapter (e.g. retire superseded versions from a retraining
 * pipeline).
 *
 * @binding
 * @section Managing Adapters
 * @example Delete an Adapter Version
 * ```typescript
 * // init
 * const deleteAdapterVersion = yield* AWS.Textract.DeleteAdapterVersion(adapter);
 *
 * // runtime
 * yield* deleteAdapterVersion({ AdapterVersion: "1" });
 * ```
 */
export interface DeleteAdapterVersion extends Binding.Service<
  DeleteAdapterVersion,
  "AWS.Textract.DeleteAdapterVersion",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<
    (
      request: Omit<textract.DeleteAdapterVersionRequest, "AdapterId">,
    ) => Effect.Effect<
      textract.DeleteAdapterVersionResponse,
      textract.DeleteAdapterVersionError
    >
  >
> {}
export const DeleteAdapterVersion = Binding.Service<DeleteAdapterVersion>(
  "AWS.Textract.DeleteAdapterVersion",
);
