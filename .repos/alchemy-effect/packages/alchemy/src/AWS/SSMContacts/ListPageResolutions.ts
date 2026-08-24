import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:ListPageResolutions`.
 *
 * List the resolution path of a page — the chain of escalation-plan and
 * on-call-schedule hops that led Incident Manager to the engaged contact.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListPageResolutionsHttp)`.
 * @binding
 * @section Working with Pages
 * @example Trace How a Contact Was Paged
 * ```typescript
 * const listPageResolutions = yield* AWS.SSMContacts.ListPageResolutions();
 *
 * const { PageResolutions } = yield* listPageResolutions({ PageId: pageArn });
 * ```
 */
export interface ListPageResolutions extends Binding.Service<
  ListPageResolutions,
  "AWS.SSMContacts.ListPageResolutions",
  () => Effect.Effect<
    (
      request: ssm.ListPageResolutionsRequest,
    ) => Effect.Effect<
      ssm.ListPageResolutionsResult,
      ssm.ListPageResolutionsError
    >
  >
> {}
export const ListPageResolutions = Binding.Service<ListPageResolutions>(
  "AWS.SSMContacts.ListPageResolutions",
);
