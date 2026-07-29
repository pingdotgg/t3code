import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:ListExperiments`.
 *
 * Enumerates the account's experiments, optionally filtered to those started
 * from a specific template — the building block of a chaos-run dashboard or
 * a guard that refuses to start a new experiment while one is already
 * running. Provide the implementation with
 * `Effect.provide(AWS.FIS.ListExperimentsHttp)`.
 * @binding
 * @section Running Experiments
 * @example Find Running Experiments for a Template
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listExperiments = yield* AWS.FIS.ListExperiments();
 *
 * // runtime
 * const { experiments } = yield* listExperiments({
 *   experimentTemplateId: templateId,
 * });
 * const running = (experiments ?? []).filter(
 *   (e) => e.state?.status === "running",
 * );
 * ```
 */
export interface ListExperiments extends Binding.Service<
  ListExperiments,
  "AWS.FIS.ListExperiments",
  () => Effect.Effect<
    (
      request?: fis.ListExperimentsRequest,
    ) => Effect.Effect<fis.ListExperimentsResponse, fis.ListExperimentsError>
  >
> {}
export const ListExperiments = Binding.Service<ListExperiments>(
  "AWS.FIS.ListExperiments",
);
