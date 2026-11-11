import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `ecr-public:GetRegistryCatalogData`.
 *
 * Reads the registry-level catalog metadata (the gallery display name).
 * Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.GetRegistryCatalogDataHttp)`.
 *
 * ### Registry Access
 * **Example:** Read The Registry Display Name
 * ```typescript
 * // init — registry-level binding takes no resource
 * const getRegistryCatalogData = yield* AWS.ECRPublic.GetRegistryCatalogData();
 *
 * // runtime
 * const result = yield* getRegistryCatalogData();
 * const displayName = result.registryCatalogData.displayName;
 * ```
 *
 * @binding
 */
export interface GetRegistryCatalogData extends Binding.Service<
  GetRegistryCatalogData,
  "AWS.ECRPublic.GetRegistryCatalogData",
  () => Effect.Effect<
    () => Effect.Effect<
      ecrpublic.GetRegistryCatalogDataResponse,
      ecrpublic.GetRegistryCatalogDataError
    >
  >
> {}

export const GetRegistryCatalogData = Binding.Service<GetRegistryCatalogData>(
  "AWS.ECRPublic.GetRegistryCatalogData",
);
