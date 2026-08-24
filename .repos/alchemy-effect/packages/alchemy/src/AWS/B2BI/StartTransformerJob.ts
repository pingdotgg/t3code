import type * as b2bi from "@distilled.cloud/aws/b2bi";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Transformer } from "./Transformer.ts";

export interface StartTransformerJobRequest extends Omit<
  b2bi.StartTransformerJobRequest,
  "transformerId"
> {}

/**
 * Runtime binding for `b2bi:StartTransformerJob`.
 *
 * Runs an asynchronous transformer job against an EDI document in S3 — the
 * bound {@link Transformer} (which must be `active`) parses and maps the
 * `inputFile` and writes the result to `outputLocation`. Poll the returned
 * `transformerJobId` with {@link GetTransformerJob}. B2BI accesses the S3
 * locations with its service principal, so the buckets need a bucket policy
 * granting `b2bi.amazonaws.com` read/write access. Provide the
 * implementation with `Effect.provide(AWS.B2BI.StartTransformerJobHttp)`.
 * @binding
 * @section Running Transformer Jobs
 * @example Transform an EDI Document in S3
 * ```typescript
 * // init — grants b2bi:StartTransformerJob on the transformer
 * const startTransformerJob = yield* AWS.B2BI.StartTransformerJob(transformer);
 *
 * // runtime
 * const { transformerJobId } = yield* startTransformerJob({
 *   inputFile: { bucketName: "my-edi-bucket", key: "inbound/order.edi" },
 *   outputLocation: { bucketName: "my-edi-bucket", key: "output/" },
 * });
 * ```
 */
export interface StartTransformerJob extends Binding.Service<
  StartTransformerJob,
  "AWS.B2BI.StartTransformerJob",
  (
    transformer: Transformer,
  ) => Effect.Effect<
    (
      request: StartTransformerJobRequest,
    ) => Effect.Effect<
      b2bi.StartTransformerJobResponse,
      b2bi.StartTransformerJobError
    >
  >
> {}
export const StartTransformerJob = Binding.Service<StartTransformerJob>(
  "AWS.B2BI.StartTransformerJob",
);
