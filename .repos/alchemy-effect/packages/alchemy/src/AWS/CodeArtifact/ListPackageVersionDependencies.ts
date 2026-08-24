import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link ListPackageVersionDependencies} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface ListPackageVersionDependenciesRequest extends Omit<
  codeartifact.ListPackageVersionDependenciesRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:ListPackageVersionDependencies`.
 *
 * Lists the direct dependencies recorded in a package version's manifest (npm `package.json`, maven `pom.xml`, …). Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.ListPackageVersionDependenciesHttp)`.
 * @binding
 * @section Inspecting Package Versions
 * @example List a Version's Dependencies
 * ```typescript
 * const listDeps = yield* AWS.CodeArtifact.ListPackageVersionDependencies(repo);
 *
 * const res = yield* listDeps({
 *   format: "npm",
 *   package: "left-pad",
 *   packageVersion: "1.3.0",
 * });
 * console.log(res.dependencies?.map((d) => d.package));
 * ```
 */
export interface ListPackageVersionDependencies extends Binding.Service<
  ListPackageVersionDependencies,
  "AWS.CodeArtifact.ListPackageVersionDependencies",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: ListPackageVersionDependenciesRequest,
    ) => Effect.Effect<
      codeartifact.ListPackageVersionDependenciesResult,
      codeartifact.ListPackageVersionDependenciesError
    >
  >
> {}

export const ListPackageVersionDependencies =
  Binding.Service<ListPackageVersionDependencies>(
    "AWS.CodeArtifact.ListPackageVersionDependencies",
  );
