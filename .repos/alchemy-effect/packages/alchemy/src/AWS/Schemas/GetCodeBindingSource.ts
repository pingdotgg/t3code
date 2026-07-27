import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Schema } from "./Schema.ts";

/**
 * Runtime binding for `schemas:GetCodeBindingSource`.
 *
 * Downloads the generated code-binding package (a zip archive, streamed as
 * `Body`) for the bound {@link Schema} in a target language. Generate the
 * package first with {@link PutCodeBinding} and wait for
 * {@link DescribeCodeBinding} to report `CREATE_COMPLETE`. The registry and
 * schema names are injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.Schemas.GetCodeBindingSourceHttp)`.
 * @binding
 * @section Code Bindings
 * @example Download The Generated Package
 * ```typescript
 * // init — bind the operation to the schema
 * const getCodeBindingSource = yield* AWS.Schemas.GetCodeBindingSource(schema);
 *
 * // runtime — Body is a Stream of Uint8Array chunks (a zip archive)
 * const { Body } = yield* getCodeBindingSource({ Language: "Python36" });
 * const bytes = yield* Stream.runFold(Body!, 0, (n, chunk) => n + chunk.length);
 * ```
 */
export interface GetCodeBindingSource extends Binding.Service<
  GetCodeBindingSource,
  "AWS.Schemas.GetCodeBindingSource",
  (schema: Schema) => Effect.Effect<
    (request: {
      /** The target language: `Java8`, `Python36`, `TypeScript3`, or `Go1`. */
      Language: string;
      /** The version of the schema. Defaults to the latest. */
      SchemaVersion?: string;
    }) => Effect.Effect<
      schemas.GetCodeBindingSourceResponse,
      schemas.GetCodeBindingSourceError
    >
  >
> {}
export const GetCodeBindingSource = Binding.Service<GetCodeBindingSource>(
  "AWS.Schemas.GetCodeBindingSource",
);
