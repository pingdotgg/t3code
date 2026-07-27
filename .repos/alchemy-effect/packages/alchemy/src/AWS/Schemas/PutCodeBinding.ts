import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Schema } from "./Schema.ts";

/**
 * Runtime binding for `schemas:PutCodeBinding`.
 *
 * Kicks off code-binding generation for the bound {@link Schema} in a target
 * language (`Java8`, `Python36`, `TypeScript3`, or `Go1`). Generation is
 * asynchronous — poll {@link DescribeCodeBinding} until the status is
 * `CREATE_COMPLETE`, then download the package with
 * {@link GetCodeBindingSource}. The registry and schema names are injected
 * from the binding. Provide the implementation with
 * `Effect.provide(AWS.Schemas.PutCodeBindingHttp)`.
 * @binding
 * @section Code Bindings
 * @example Generate Python Bindings
 * ```typescript
 * // init — bind the operation to the schema
 * const putCodeBinding = yield* AWS.Schemas.PutCodeBinding(schema);
 *
 * // runtime
 * const { Status } = yield* putCodeBinding({ Language: "Python36" });
 * // Status is "CREATE_IN_PROGRESS" until generation finishes
 * ```
 */
export interface PutCodeBinding extends Binding.Service<
  PutCodeBinding,
  "AWS.Schemas.PutCodeBinding",
  (schema: Schema) => Effect.Effect<
    (request: {
      /** The target language: `Java8`, `Python36`, `TypeScript3`, or `Go1`. */
      Language: string;
      /** The version of the schema to generate bindings for. Defaults to the latest. */
      SchemaVersion?: string;
    }) => Effect.Effect<
      schemas.PutCodeBindingResponse,
      schemas.PutCodeBindingError
    >
  >
> {}
export const PutCodeBinding = Binding.Service<PutCodeBinding>(
  "AWS.Schemas.PutCodeBinding",
);
