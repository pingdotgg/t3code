import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:ListExperimentResolvedTargets`.
 *
 * Lists the concrete resources an experiment's targets resolved to — the
 * exact instances, tasks, or functions the faults were injected into — so a
 * post-run report can name the blast radius. Provide the implementation with
 * `Effect.provide(AWS.FIS.ListExperimentResolvedTargetsHttp)`.
 * @binding
 * @section Running Experiments
 * @example Report an Experiment's Blast Radius
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResolvedTargets = yield* AWS.FIS.ListExperimentResolvedTargets();
 *
 * // runtime
 * const { resolvedTargets } = yield* listResolvedTargets({
 *   experimentId,
 * });
 * for (const target of resolvedTargets ?? []) {
 *   console.log(target.targetName, target.targetInformation);
 * }
 * ```
 */
export interface ListExperimentResolvedTargets extends Binding.Service<
  ListExperimentResolvedTargets,
  "AWS.FIS.ListExperimentResolvedTargets",
  () => Effect.Effect<
    (
      request: fis.ListExperimentResolvedTargetsRequest,
    ) => Effect.Effect<
      fis.ListExperimentResolvedTargetsResponse,
      fis.ListExperimentResolvedTargetsError
    >
  >
> {}
export const ListExperimentResolvedTargets =
  Binding.Service<ListExperimentResolvedTargets>(
    "AWS.FIS.ListExperimentResolvedTargets",
  );
