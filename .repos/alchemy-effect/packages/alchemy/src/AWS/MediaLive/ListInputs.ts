import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `medialive:ListInputs`.
 *
 * Enumerates the account's MediaLive inputs (one page per call — pass
 * `NextToken` from the previous response to continue) — e.g. an
 * inventory endpoint that maps ingest endpoints to the channels they
 * feed. Account-level: the deploy-time grant is `medialive:ListInputs`
 * on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaLive.ListInputsHttp)`.
 * @binding
 * @section Observing Inputs
 * @example Enumerate the Account's Inputs
 * ```typescript
 * // init — bind the account-level operation
 * const listInputs = yield* AWS.MediaLive.ListInputs();
 *
 * // runtime
 * const { Inputs } = yield* listInputs({ MaxResults: 20 });
 * const attached = (Inputs ?? []).filter((i) => i.State === "ATTACHED");
 * ```
 */
export interface ListInputs extends Binding.Service<
  ListInputs,
  "AWS.MediaLive.ListInputs",
  () => Effect.Effect<
    (
      request?: medialive.ListInputsRequest,
    ) => Effect.Effect<medialive.ListInputsResponse, medialive.ListInputsError>
  >
> {}
export const ListInputs = Binding.Service<ListInputs>(
  "AWS.MediaLive.ListInputs",
);
