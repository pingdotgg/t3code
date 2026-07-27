import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link ListPackageVersionAssets} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface ListPackageVersionAssetsRequest extends Omit<
  codeartifact.ListPackageVersionAssetsRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:ListPackageVersionAssets`.
 *
 * Lists the assets (files) attached to a package version in the bound repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.ListPackageVersionAssetsHttp)`.
 * @binding
 * @section Reading Assets
 * @example List a Version's Assets
 * ```typescript
 * const listAssets = yield* AWS.CodeArtifact.ListPackageVersionAssets(repo);
 *
 * const res = yield* listAssets({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   packageVersion: "1.0.0",
 * });
 * console.log(res.assets?.map((a) => a.name));
 * ```
 */
export interface ListPackageVersionAssets extends Binding.Service<
  ListPackageVersionAssets,
  "AWS.CodeArtifact.ListPackageVersionAssets",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: ListPackageVersionAssetsRequest,
    ) => Effect.Effect<
      codeartifact.ListPackageVersionAssetsResult,
      codeartifact.ListPackageVersionAssetsError
    >
  >
> {}

export const ListPackageVersionAssets =
  Binding.Service<ListPackageVersionAssets>(
    "AWS.CodeArtifact.ListPackageVersionAssets",
  );
