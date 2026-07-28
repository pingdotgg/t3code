import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/**
 * Request for {@link GetRepositoryCatalogData} — `repositoryName` is
 * injected.
 */
export interface GetRepositoryCatalogDataRequest extends Omit<
  ecrpublic.GetRepositoryCatalogDataRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:GetRepositoryCatalogData`.
 *
 * Reads the gallery catalog metadata (description, architectures, about /
 * usage markdown) of the bound {@link PublicRepository}. Provide the
 * implementation with
 * `Effect.provide(AWS.ECRPublic.GetRepositoryCatalogDataHttp)`.
 *
 * @binding
 * @section Catalog Metadata
 * @example Read A Repository's Gallery Metadata
 * ```typescript
 * // init
 * const getCatalogData = yield* AWS.ECRPublic.GetRepositoryCatalogData(repository);
 *
 * // runtime
 * const result = yield* getCatalogData();
 * const description = result.catalogData?.description;
 * ```
 */
export interface GetRepositoryCatalogData extends Binding.Service<
  GetRepositoryCatalogData,
  "AWS.ECRPublic.GetRepositoryCatalogData",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request?: GetRepositoryCatalogDataRequest,
    ) => Effect.Effect<
      ecrpublic.GetRepositoryCatalogDataResponse,
      ecrpublic.GetRepositoryCatalogDataError
    >
  >
> {}

export const GetRepositoryCatalogData =
  Binding.Service<GetRepositoryCatalogData>(
    "AWS.ECRPublic.GetRepositoryCatalogData",
  );
