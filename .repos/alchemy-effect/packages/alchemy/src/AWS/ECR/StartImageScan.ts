import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link StartImageScan} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface StartImageScanRequest extends Omit<
  ecr.StartImageScanRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:StartImageScan`.
 *
 * Starts an on-demand vulnerability scan of an image in the bound repository (basic scanning; one scan per image per day). Provide the implementation with
 * `Effect.provide(AWS.ECR.StartImageScanHttp)`.
 * @binding
 * @section Image Scanning
 * @example Scan an Image on Demand
 * ```typescript
 * const startImageScan = yield* AWS.ECR.StartImageScan(repository);
 *
 * const res = yield* startImageScan({ imageId: { imageTag: "latest" } });
 * console.log(res.imageScanStatus?.status);
 * ```
 */
export interface StartImageScan extends Binding.Service<
  StartImageScan,
  "AWS.ECR.StartImageScan",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: StartImageScanRequest,
    ) => Effect.Effect<ecr.StartImageScanResponse, ecr.StartImageScanError>
  >
> {}

export const StartImageScan = Binding.Service<StartImageScan>(
  "AWS.ECR.StartImageScan",
);
