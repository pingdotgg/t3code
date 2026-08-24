import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDataRepositoryAssociations` operation
 * (IAM action `fsx:DescribeDataRepositoryAssociations` on `*`).
 *
 * Lists the S3 data repository associations linked to Lustre file systems —
 * optionally filtered by `file-system-id` — from inside a function runtime,
 * e.g. to discover the S3 prefix a {@link CreateDataRepositoryTask} export
 * will land in. Provide the implementation with
 * `Effect.provide(AWS.FSx.DescribeDataRepositoryAssociationsHttp)`.
 * @binding
 * @section Data Repository Tasks
 * @example List a file system's data repository associations
 * ```typescript
 * const describeDataRepositoryAssociations =
 *   yield* AWS.FSx.DescribeDataRepositoryAssociations();
 *
 * const response = yield* describeDataRepositoryAssociations({
 *   Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
 * });
 * yield* Effect.log(response.Associations?.[0]?.DataRepositoryPath);
 * ```
 */
export interface DescribeDataRepositoryAssociations extends Binding.Service<
  DescribeDataRepositoryAssociations,
  "AWS.FSx.DescribeDataRepositoryAssociations",
  () => Effect.Effect<
    (
      request?: fsx.DescribeDataRepositoryAssociationsRequest,
    ) => Effect.Effect<
      fsx.DescribeDataRepositoryAssociationsResponse,
      fsx.DescribeDataRepositoryAssociationsError
    >
  >
> {}
export const DescribeDataRepositoryAssociations =
  Binding.Service<DescribeDataRepositoryAssociations>(
    "AWS.FSx.DescribeDataRepositoryAssociations",
  );
