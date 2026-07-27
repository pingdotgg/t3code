import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:ListJobParameterDefinitions`.
 *
 * Lists the parameter definitions a job's Open Job Description template
 * declares (name, type, default, allowed values) for a job in the bound
 * {@link Queue} — useful to introspect what a resubmission would accept.
 * The queue's `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.Deadline.ListJobParameterDefinitionsHttp)`.
 * @binding
 * @section Monitoring Jobs
 * @example Introspect A Job's Parameters
 * ```typescript
 * // init — bind the operation to the queue
 * const listJobParameterDefinitions =
 *   yield* AWS.Deadline.ListJobParameterDefinitions(queue);
 *
 * // runtime
 * const { jobParameterDefinitions } =
 *   yield* listJobParameterDefinitions({ jobId });
 * ```
 */
export interface ListJobParameterDefinitions extends Binding.Service<
  ListJobParameterDefinitions,
  "AWS.Deadline.ListJobParameterDefinitions",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<
        deadline.ListJobParameterDefinitionsRequest,
        "farmId" | "queueId"
      >,
    ) => Effect.Effect<
      deadline.ListJobParameterDefinitionsResponse,
      deadline.ListJobParameterDefinitionsError
    >
  >
> {}
export const ListJobParameterDefinitions =
  Binding.Service<ListJobParameterDefinitions>(
    "AWS.Deadline.ListJobParameterDefinitions",
  );
