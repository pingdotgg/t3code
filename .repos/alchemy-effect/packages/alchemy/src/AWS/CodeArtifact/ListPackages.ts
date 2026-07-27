import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link ListPackages} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface ListPackagesRequest extends Omit<
  codeartifact.ListPackagesRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:ListPackages`.
 *
 * Lists the packages stored in the bound repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.ListPackagesHttp)`.
 * @binding
 * @section Browsing Packages
 * @example List Packages by Prefix
 * ```typescript
 * const listPackages = yield* AWS.CodeArtifact.ListPackages(repo);
 *
 * const res = yield* listPackages({ packagePrefix: "my-" });
 * for (const pkg of res.packages ?? []) console.log(pkg.package);
 * ```
 */
export interface ListPackages extends Binding.Service<
  ListPackages,
  "AWS.CodeArtifact.ListPackages",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: ListPackagesRequest,
    ) => Effect.Effect<
      codeartifact.ListPackagesResult,
      codeartifact.ListPackagesError
    >
  >
> {}

export const ListPackages = Binding.Service<ListPackages>(
  "AWS.CodeArtifact.ListPackages",
);
