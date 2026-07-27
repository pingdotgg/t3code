import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link CopyPackageVersions} — `domain`, `domainOwner`, and
 * `destinationRepository` are injected from the bound {@link Repository};
 * `sourceRepository` names a sibling repository in the same domain.
 */
export interface CopyPackageVersionsRequest extends Omit<
  codeartifact.CopyPackageVersionsRequest,
  "domain" | "domainOwner" | "destinationRepository"
> {}

/**
 * Runtime binding for `codeartifact:CopyPackageVersions`.
 *
 * Copies package versions from another repository in the same domain into the
 * bound repository (the destination) — the standard promotion flow from a
 * staging repository to a release repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.CopyPackageVersionsHttp)`.
 * @binding
 * @section Promoting Packages
 * @example Promote a Version from Staging
 * ```typescript
 * const copyVersions = yield* AWS.CodeArtifact.CopyPackageVersions(releaseRepo);
 *
 * const res = yield* copyVersions({
 *   sourceRepository: "staging",
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   versions: ["1.0.0"],
 * });
 * console.log(res.successfulVersions);
 * ```
 */
export interface CopyPackageVersions extends Binding.Service<
  CopyPackageVersions,
  "AWS.CodeArtifact.CopyPackageVersions",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: CopyPackageVersionsRequest,
    ) => Effect.Effect<
      codeartifact.CopyPackageVersionsResult,
      codeartifact.CopyPackageVersionsError
    >
  >
> {}

export const CopyPackageVersions = Binding.Service<CopyPackageVersions>(
  "AWS.CodeArtifact.CopyPackageVersions",
);
