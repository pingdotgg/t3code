import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetDomainSuggestionsRequest
  extends route53domains.GetDomainSuggestionsRequest {}

/**
 * Runtime binding for `route53domains:GetDomainSuggestions` — return a list
 * of suggested domain names based on a seed name, optionally restricted to
 * names that are currently available for registration.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:GetDomainSuggestions` on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.GetDomainSuggestionsHttp)`.
 *
 * @binding
 * @section Suggesting Domain Names
 * @example Suggest Available Alternatives for a Name
 * ```typescript
 * // init
 * const getDomainSuggestions =
 *   yield* AWS.Route53Domains.GetDomainSuggestions();
 *
 * // runtime
 * const result = yield* getDomainSuggestions({
 *   DomainName: "example.com",
 *   SuggestionCount: 10,
 *   OnlyAvailable: true,
 * });
 * const names = (result.SuggestionsList ?? []).map((s) => s.DomainName);
 * ```
 */
export interface GetDomainSuggestions extends Binding.Service<
  GetDomainSuggestions,
  "AWS.Route53Domains.GetDomainSuggestions",
  () => Effect.Effect<
    (
      request: GetDomainSuggestionsRequest,
    ) => Effect.Effect<
      route53domains.GetDomainSuggestionsResponse,
      route53domains.GetDomainSuggestionsError
    >
  >
> {}
export const GetDomainSuggestions = Binding.Service<GetDomainSuggestions>(
  "AWS.Route53Domains.GetDomainSuggestions",
);
