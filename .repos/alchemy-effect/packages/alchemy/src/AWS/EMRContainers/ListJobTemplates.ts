import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `emr-containers:ListJobTemplates`.
 *
 * Enumerates the account's EMR on EKS job templates, optionally filtered by
 * creation time. Account-level — no resource argument. Provide the
 * implementation with
 * `Effect.provide(AWS.EMRContainers.ListJobTemplatesHttp)`.
 * @binding
 * @section Job Templates
 * @example List All Templates
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listJobTemplates = yield* AWS.EMRContainers.ListJobTemplates();
 *
 * // runtime
 * const { templates } = yield* listJobTemplates();
 * yield* Effect.log(`${templates?.length ?? 0} job templates`);
 * ```
 */
export interface ListJobTemplates extends Binding.Service<
  ListJobTemplates,
  "AWS.EMRContainers.ListJobTemplates",
  () => Effect.Effect<
    (
      request?: emrc.ListJobTemplatesRequest,
    ) => Effect.Effect<
      emrc.ListJobTemplatesResponse,
      emrc.ListJobTemplatesError
    >
  >
> {}
export const ListJobTemplates = Binding.Service<ListJobTemplates>(
  "AWS.EMRContainers.ListJobTemplates",
);
