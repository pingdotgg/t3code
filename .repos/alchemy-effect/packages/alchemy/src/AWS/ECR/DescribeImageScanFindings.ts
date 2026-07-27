import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DescribeImageScanFindings} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface DescribeImageScanFindingsRequest extends Omit<
  ecr.DescribeImageScanFindingsRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:DescribeImageScanFindings`.
 *
 * Returns the vulnerability findings of the most recent scan of an image in the bound repository. Provide the implementation with
 * `Effect.provide(AWS.ECR.DescribeImageScanFindingsHttp)`.
 * @binding
 * @section Image Scanning
 * @example Read Scan Findings
 * ```typescript
 * const describeScanFindings = yield* AWS.ECR.DescribeImageScanFindings(repository);
 *
 * const res = yield* describeScanFindings({ imageId: { imageTag: "latest" } });
 * console.log(res.imageScanFindings?.findingSeverityCounts);
 * ```
 */
export interface DescribeImageScanFindings extends Binding.Service<
  DescribeImageScanFindings,
  "AWS.ECR.DescribeImageScanFindings",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: DescribeImageScanFindingsRequest,
    ) => Effect.Effect<
      ecr.DescribeImageScanFindingsResponse,
      ecr.DescribeImageScanFindingsError
    >
  >
> {}

export const DescribeImageScanFindings =
  Binding.Service<DescribeImageScanFindings>(
    "AWS.ECR.DescribeImageScanFindings",
  );
