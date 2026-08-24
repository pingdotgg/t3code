import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:ListTerminologies` — list the custom
 * terminologies in the account and region.
 *
 * @binding
 * @section Reading Terminologies
 * @example List terminologies
 * ```typescript
 * // init
 * const listTerminologies = yield* AWS.Translate.ListTerminologies();
 *
 * // runtime
 * const result = yield* listTerminologies({ MaxResults: 50 });
 * // result.TerminologyPropertiesList -> [{ Name, Arn, TermCount, … }, …]
 * ```
 */
export interface ListTerminologies extends Binding.Service<
  ListTerminologies,
  "AWS.Translate.ListTerminologies",
  () => Effect.Effect<
    (
      request?: translate.ListTerminologiesRequest,
    ) => Effect.Effect<
      translate.ListTerminologiesResponse,
      translate.ListTerminologiesError
    >
  >
> {}
export const ListTerminologies = Binding.Service<ListTerminologies>(
  "AWS.Translate.ListTerminologies",
);
