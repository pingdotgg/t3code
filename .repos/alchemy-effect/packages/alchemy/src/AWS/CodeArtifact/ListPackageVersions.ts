import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link ListPackageVersions} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface ListPackageVersionsRequest extends Omit<
  codeartifact.ListPackageVersionsRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:ListPackageVersions`.
 *
 * Lists a package's versions in the bound repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.ListPackageVersionsHttp)`.
 * @binding
 * @section Browsing Package Versions
 * @example List Published Versions
 * ```typescript
 * const listVersions = yield* AWS.CodeArtifact.ListPackageVersions(repo);
 *
 * const res = yield* listVersions({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   status: "Published",
 * });
 * console.log(res.versions?.map((v) => v.version));
 * ```
 */
export interface ListPackageVersions extends Binding.Service<
  ListPackageVersions,
  "AWS.CodeArtifact.ListPackageVersions",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: ListPackageVersionsRequest,
    ) => Effect.Effect<
      codeartifact.ListPackageVersionsResult,
      codeartifact.ListPackageVersionsError
    >
  >
> {}

export const ListPackageVersions = Binding.Service<ListPackageVersions>(
  "AWS.CodeArtifact.ListPackageVersions",
);
