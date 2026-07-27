import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link GetPackageVersionReadme} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface GetPackageVersionReadmeRequest extends Omit<
  codeartifact.GetPackageVersionReadmeRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:GetPackageVersionReadme`.
 *
 * Reads a package version's readme, where the format supports one. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.GetPackageVersionReadmeHttp)`.
 * @binding
 * @section Inspecting Package Versions
 * @example Get a Version's Readme
 * ```typescript
 * const getReadme = yield* AWS.CodeArtifact.GetPackageVersionReadme(repo);
 *
 * const res = yield* getReadme({
 *   format: "npm",
 *   package: "left-pad",
 *   packageVersion: "1.3.0",
 * });
 * console.log(res.readme);
 * ```
 */
export interface GetPackageVersionReadme extends Binding.Service<
  GetPackageVersionReadme,
  "AWS.CodeArtifact.GetPackageVersionReadme",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: GetPackageVersionReadmeRequest,
    ) => Effect.Effect<
      codeartifact.GetPackageVersionReadmeResult,
      codeartifact.GetPackageVersionReadmeError
    >
  >
> {}

export const GetPackageVersionReadme = Binding.Service<GetPackageVersionReadme>(
  "AWS.CodeArtifact.GetPackageVersionReadme",
);
