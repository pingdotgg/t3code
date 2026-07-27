import type * as codeartifact from "@distilled.cloud/aws/codeartifact";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link GetRepositoryEndpoint} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface GetRepositoryEndpointRequest extends Omit<
  codeartifact.GetRepositoryEndpointRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:GetRepositoryEndpoint`.
 *
 * Resolves the URL package managers (npm, pip, maven, …) use to talk to the bound repository for a given package format. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.GetRepositoryEndpointHttp)`.
 * @binding
 * @section Resolving the Registry Endpoint
 * @example Get the npm Endpoint
 * ```typescript
 * const getEndpoint = yield* AWS.CodeArtifact.GetRepositoryEndpoint(repo);
 *
 * const res = yield* getEndpoint({ format: "npm" });
 * console.log(res.repositoryEndpoint);
 * ```
 */
export interface GetRepositoryEndpoint extends Binding.Service<
  GetRepositoryEndpoint,
  "AWS.CodeArtifact.GetRepositoryEndpoint",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: GetRepositoryEndpointRequest,
    ) => Effect.Effect<
      codeartifact.GetRepositoryEndpointResult,
      codeartifact.GetRepositoryEndpointError
    >
  >
> {}

export const GetRepositoryEndpoint = Binding.Service<GetRepositoryEndpoint>(
  "AWS.CodeArtifact.GetRepositoryEndpoint",
);
