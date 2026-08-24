import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Schema } from "./Schema.ts";

/**
 * Runtime binding for `schemas:DescribeCodeBinding`.
 *
 * Reads the code-binding generation status for the bound {@link Schema} in a
 * target language — poll it after {@link PutCodeBinding} until the status is
 * `CREATE_COMPLETE`. The registry and schema names are injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Schemas.DescribeCodeBindingHttp)`.
 * @binding
 * @section Code Bindings
 * @example Poll Generation Status
 * ```typescript
 * // init — bind the operation to the schema
 * const describeCodeBinding = yield* AWS.Schemas.DescribeCodeBinding(schema);
 *
 * // runtime
 * const { Status } = yield* describeCodeBinding({ Language: "Python36" });
 * if (Status === "CREATE_COMPLETE") {
 *   // the package is ready to download via GetCodeBindingSource
 * }
 * ```
 */
export interface DescribeCodeBinding extends Binding.Service<
  DescribeCodeBinding,
  "AWS.Schemas.DescribeCodeBinding",
  (schema: Schema) => Effect.Effect<
    (request: {
      /** The target language: `Java8`, `Python36`, `TypeScript3`, or `Go1`. */
      Language: string;
      /** The version of the schema. Defaults to the latest. */
      SchemaVersion?: string;
    }) => Effect.Effect<
      schemas.DescribeCodeBindingResponse,
      schemas.DescribeCodeBindingError
    >
  >
> {}
export const DescribeCodeBinding = Binding.Service<DescribeCodeBinding>(
  "AWS.Schemas.DescribeCodeBinding",
);
