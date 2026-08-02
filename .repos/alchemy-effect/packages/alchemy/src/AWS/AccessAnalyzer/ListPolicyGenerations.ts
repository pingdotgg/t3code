import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:ListPolicyGenerations`.
 *
 * Lists the account's recent policy-generation jobs. Provide the
 * implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListPolicyGenerationsHttp)`.
 * @binding
 * @section Policy Generation
 * @example List Policy Generations
 * ```typescript
 * const listGenerations =
 *   yield* AWS.AccessAnalyzer.ListPolicyGenerations();
 * const page = yield* listGenerations();
 * ```
 */
export interface ListPolicyGenerations extends Binding.Service<
  ListPolicyGenerations,
  "AWS.AccessAnalyzer.ListPolicyGenerations",
  () => Effect.Effect<
    (
      request?: aa.ListPolicyGenerationsRequest,
    ) => Effect.Effect<
      aa.ListPolicyGenerationsResponse,
      aa.ListPolicyGenerationsError
    >
  >
> {}

export const ListPolicyGenerations = Binding.Service<ListPolicyGenerations>(
  "AWS.AccessAnalyzer.ListPolicyGenerations",
);
