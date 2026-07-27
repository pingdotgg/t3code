import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Runtime binding for `textract:CreateAdapterVersion` — train a new
 * version of the bound adapter from an annotated dataset manifest in S3
 * (automated retraining pipelines). The `AdapterId` is injected
 * automatically; the caller also needs read access to the manifest and
 * write access to the output bucket.
 *
 * @binding
 * @section Managing Adapters
 * @example Train a New Adapter Version
 * ```typescript
 * // init
 * const createAdapterVersion = yield* AWS.Textract.CreateAdapterVersion(adapter);
 *
 * // runtime
 * const { AdapterVersion } = yield* createAdapterVersion({
 *   DatasetConfig: {
 *     ManifestS3Object: { Bucket: bucketName, Name: "manifest.jsonl" },
 *   },
 *   OutputConfig: { S3Bucket: bucketName, S3Prefix: "training-output/" },
 * });
 * ```
 */
export interface CreateAdapterVersion extends Binding.Service<
  CreateAdapterVersion,
  "AWS.Textract.CreateAdapterVersion",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<
    (
      request: Omit<textract.CreateAdapterVersionRequest, "AdapterId">,
    ) => Effect.Effect<
      textract.CreateAdapterVersionResponse,
      textract.CreateAdapterVersionError
    >
  >
> {}
export const CreateAdapterVersion = Binding.Service<CreateAdapterVersion>(
  "AWS.Textract.CreateAdapterVersion",
);
