import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DisposePackageVersions} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface DisposePackageVersionsRequest extends Omit<
  codeartifact.DisposePackageVersionsRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:DisposePackageVersions`.
 *
 * Disposes package versions — deletes their assets and pins the version status to `Disposed` so the version number can never be reused with different content. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.DisposePackageVersionsHttp)`.
 * @binding
 * @section Deleting Packages
 * @example Dispose Package Versions
 * ```typescript
 * const dispose = yield* AWS.CodeArtifact.DisposePackageVersions(repo);
 *
 * const res = yield* dispose({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   versions: ["1.0.0"],
 * });
 * console.log(res.successfulVersions);
 * ```
 */
export interface DisposePackageVersions extends Binding.Service<
  DisposePackageVersions,
  "AWS.CodeArtifact.DisposePackageVersions",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: DisposePackageVersionsRequest,
    ) => Effect.Effect<
      codeartifact.DisposePackageVersionsResult,
      codeartifact.DisposePackageVersionsError
    >
  >
> {}

export const DisposePackageVersions = Binding.Service<DisposePackageVersions>(
  "AWS.CodeArtifact.DisposePackageVersions",
);
