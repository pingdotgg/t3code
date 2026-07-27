import type * as b2bi from "@distilled.cloud/aws/b2bi";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Transformer } from "./Transformer.ts";

export interface GetTransformerJobRequest extends Omit<
  b2bi.GetTransformerJobRequest,
  "transformerId"
> {}

/**
 * Runtime binding for `b2bi:GetTransformerJob`.
 *
 * Polls the status of an asynchronous transformer job started with
 * {@link StartTransformerJob} — `status` progresses from `running` to
 * `succeeded` (with `outputFiles`) or `failed` (with `message`). Provide the
 * implementation with `Effect.provide(AWS.B2BI.GetTransformerJobHttp)`.
 * @binding
 * @section Running Transformer Jobs
 * @example Poll a Transformer Job Until It Finishes
 * ```typescript
 * // init — grants b2bi:GetTransformerJob on the transformer
 * const getTransformerJob = yield* AWS.B2BI.GetTransformerJob(transformer);
 *
 * // runtime
 * const job = yield* getTransformerJob({ transformerJobId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (job) => job.status !== "running",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface GetTransformerJob extends Binding.Service<
  GetTransformerJob,
  "AWS.B2BI.GetTransformerJob",
  (
    transformer: Transformer,
  ) => Effect.Effect<
    (
      request: GetTransformerJobRequest,
    ) => Effect.Effect<
      b2bi.GetTransformerJobResponse,
      b2bi.GetTransformerJobError
    >
  >
> {}
export const GetTransformerJob = Binding.Service<GetTransformerJob>(
  "AWS.B2BI.GetTransformerJob",
);
