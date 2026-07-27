import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobTemplate } from "./JobTemplate.ts";

/**
 * Runtime binding for `emr-containers:DescribeJobTemplate`.
 *
 * Reads the bound {@link JobTemplate}'s stored `StartJobRun` values — the
 * execution role, release label, job driver, and parameter configuration.
 * The template ID is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.EMRContainers.DescribeJobTemplateHttp)`.
 * @binding
 * @section Job Templates
 * @example Read The Bound Template
 * ```typescript
 * // init — bind the operation to the template
 * const describeJobTemplate =
 *   yield* AWS.EMRContainers.DescribeJobTemplate(template);
 *
 * // runtime
 * const { jobTemplate } = yield* describeJobTemplate();
 * yield* Effect.log(
 *   `template targets ${jobTemplate?.jobTemplateData.releaseLabel}`,
 * );
 * ```
 */
export interface DescribeJobTemplate extends Binding.Service<
  DescribeJobTemplate,
  "AWS.EMRContainers.DescribeJobTemplate",
  (
    template: JobTemplate,
  ) => Effect.Effect<
    () => Effect.Effect<
      emrc.DescribeJobTemplateResponse,
      emrc.DescribeJobTemplateError
    >
  >
> {}
export const DescribeJobTemplate = Binding.Service<DescribeJobTemplate>(
  "AWS.EMRContainers.DescribeJobTemplate",
);
