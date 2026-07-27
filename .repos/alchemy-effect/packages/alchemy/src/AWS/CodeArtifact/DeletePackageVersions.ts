import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DeletePackageVersions} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface DeletePackageVersionsRequest extends Omit<
  codeartifact.DeletePackageVersionsRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:DeletePackageVersions`.
 *
 * Deletes specific versions of a package from the bound repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.DeletePackageVersionsHttp)`.
 * @binding
 * @section Deleting Packages
 * @example Delete Package Versions
 * ```typescript
 * const deleteVersions = yield* AWS.CodeArtifact.DeletePackageVersions(repo);
 *
 * const res = yield* deleteVersions({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   versions: ["1.0.0"],
 * });
 * console.log(res.successfulVersions);
 * ```
 */
export interface DeletePackageVersions extends Binding.Service<
  DeletePackageVersions,
  "AWS.CodeArtifact.DeletePackageVersions",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: DeletePackageVersionsRequest,
    ) => Effect.Effect<
      codeartifact.DeletePackageVersionsResult,
      codeartifact.DeletePackageVersionsError
    >
  >
> {}

export const DeletePackageVersions = Binding.Service<DeletePackageVersions>(
  "AWS.CodeArtifact.DeletePackageVersions",
);
