import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link GetPackageVersionAsset} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface GetPackageVersionAssetRequest extends Omit<
  codeartifact.GetPackageVersionAssetRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:GetPackageVersionAsset`.
 *
 * Downloads one asset (file) of a package version from the bound repository. The result's `asset` is a `Stream` of bytes. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.GetPackageVersionAssetHttp)`.
 * @binding
 * @section Reading Assets
 * @example Download an Asset
 * ```typescript
 * import * as Stream from "effect/Stream";
 *
 * const getAsset = yield* AWS.CodeArtifact.GetPackageVersionAsset(repo);
 *
 * const res = yield* getAsset({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   packageVersion: "1.0.0",
 *   asset: "artifact.bin",
 * });
 * const bytes = yield* Stream.mkString(
 *   Stream.decodeText(res.asset!),
 * );
 * ```
 */
export interface GetPackageVersionAsset extends Binding.Service<
  GetPackageVersionAsset,
  "AWS.CodeArtifact.GetPackageVersionAsset",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: GetPackageVersionAssetRequest,
    ) => Effect.Effect<
      codeartifact.GetPackageVersionAssetResult,
      codeartifact.GetPackageVersionAssetError
    >
  >
> {}

export const GetPackageVersionAsset = Binding.Service<GetPackageVersionAsset>(
  "AWS.CodeArtifact.GetPackageVersionAsset",
);
