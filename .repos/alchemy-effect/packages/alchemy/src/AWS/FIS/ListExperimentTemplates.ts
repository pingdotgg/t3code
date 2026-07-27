import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:ListExperimentTemplates`.
 *
 * Enumerates the account's experiment templates — the catalog a chaos
 * orchestrator picks its next run from. Provide the implementation with
 * `Effect.provide(AWS.FIS.ListExperimentTemplatesHttp)`.
 * @binding
 * @section Inspecting Templates
 * @example List the Account's Templates
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listExperimentTemplates = yield* AWS.FIS.ListExperimentTemplates();
 *
 * // runtime
 * const { experimentTemplates } = yield* listExperimentTemplates();
 * console.log((experimentTemplates ?? []).map((t) => t.id));
 * ```
 */
export interface ListExperimentTemplates extends Binding.Service<
  ListExperimentTemplates,
  "AWS.FIS.ListExperimentTemplates",
  () => Effect.Effect<
    (
      request?: fis.ListExperimentTemplatesRequest,
    ) => Effect.Effect<
      fis.ListExperimentTemplatesResponse,
      fis.ListExperimentTemplatesError
    >
  >
> {}
export const ListExperimentTemplates = Binding.Service<ListExperimentTemplates>(
  "AWS.FIS.ListExperimentTemplates",
);
