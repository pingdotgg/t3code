import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:SearchVulnerabilities`.
 *
 * Lists Amazon Inspector coverage details for a specific vulnerability.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.SearchVulnerabilitiesHttp)`.
 * @binding
 * @section Coverage & Vulnerability Intel
 * @example Look Up a CVE
 * ```typescript
 * // init
 * const searchVulnerabilities = yield* AWS.Inspector2.SearchVulnerabilities();
 *
 * // runtime
 * const { vulnerabilities } = yield* searchVulnerabilities({
 *   filterCriteria: { vulnerabilityIds: ["CVE-2021-44228"] },
 * });
 * ```
 */
export interface SearchVulnerabilities extends Binding.Service<
  SearchVulnerabilities,
  "AWS.Inspector2.SearchVulnerabilities",
  () => Effect.Effect<
    (
      request: inspector2.SearchVulnerabilitiesRequest,
    ) => Effect.Effect<
      inspector2.SearchVulnerabilitiesResponse,
      inspector2.SearchVulnerabilitiesError
    >
  >
> {}
export const SearchVulnerabilities = Binding.Service<SearchVulnerabilities>(
  "AWS.Inspector2.SearchVulnerabilities",
);
