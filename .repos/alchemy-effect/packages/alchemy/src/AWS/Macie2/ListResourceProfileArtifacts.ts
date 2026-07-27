import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListResourceProfileArtifacts`.
 *
 * Retrieves information about objects that Amazon Macie selected from an S3 bucket for automated sensitive data discovery.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListResourceProfileArtifactsHttp)`.
 * @binding
 * @section Automated Discovery
 * @example List a Profile's Analyzed Objects
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResourceProfileArtifacts = yield* AWS.Macie2.ListResourceProfileArtifacts();
 *
 * // runtime
 * const { artifacts } = yield* listResourceProfileArtifacts({ resourceArn: bucketArn });
 * ```
 */
export interface ListResourceProfileArtifacts extends Binding.Service<
  ListResourceProfileArtifacts,
  "AWS.Macie2.ListResourceProfileArtifacts",
  () => Effect.Effect<
    (
      request?: macie2.ListResourceProfileArtifactsRequest,
    ) => Effect.Effect<
      macie2.ListResourceProfileArtifactsResponse,
      macie2.ListResourceProfileArtifactsError
    >
  >
> {}
export const ListResourceProfileArtifacts =
  Binding.Service<ListResourceProfileArtifacts>(
    "AWS.Macie2.ListResourceProfileArtifacts",
  );
