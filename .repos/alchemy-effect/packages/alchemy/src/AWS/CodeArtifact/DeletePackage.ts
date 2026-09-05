import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DeletePackage} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface DeletePackageRequest extends Omit<
  codeartifact.DeletePackageRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:DeletePackage`.
 *
 * Deletes a package and all of its versions from the bound repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.DeletePackageHttp)`.
 * @binding
 * @section Deleting Packages
 * @example Delete a Package
 * ```typescript
 * const deletePackage = yield* AWS.CodeArtifact.DeletePackage(repo);
 *
 * yield* deletePackage({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 * });
 * ```
 */
export interface DeletePackage extends Binding.Service<
  DeletePackage,
  "AWS.CodeArtifact.DeletePackage",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: DeletePackageRequest,
    ) => Effect.Effect<
      codeartifact.DeletePackageResult,
      codeartifact.DeletePackageError
    >
  >
> {}

export const DeletePackage = Binding.Service<DeletePackage>(
  "AWS.CodeArtifact.DeletePackage",
);
