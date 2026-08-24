import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationLibrary } from "./DataAutomationLibrary.ts";

/**
 * `GetDataAutomationLibraryEntity` request with `libraryArn` injected from
 * the bound {@link DataAutomationLibrary}.
 */
export interface GetDataAutomationLibraryEntityRequest extends Omit<
  bda.GetDataAutomationLibraryEntityRequest,
  "libraryArn"
> {}

/**
 * Runtime binding for the `GetDataAutomationLibraryEntity` operation (IAM
 * action `bedrock:GetDataAutomationLibraryEntity` on the library ARN) —
 * read a single entity (e.g. a `VOCABULARY` entry with its phrases) from the
 * bound library.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.GetDataAutomationLibraryEntityHttp)`.
 * @binding
 * @section Library Entities
 * @example Read A Vocabulary Entity
 * ```typescript
 * // deploy time — bind the library
 * const getEntity =
 *   yield* AWS.BedrockDataAutomation.GetDataAutomationLibraryEntity(library);
 *
 * // runtime — fetch the entity written by an ingestion job
 * const { entity } = yield* getEntity({
 *   entityType: "VOCABULARY",
 *   entityId,
 * });
 * ```
 */
export interface GetDataAutomationLibraryEntity extends Binding.Service<
  GetDataAutomationLibraryEntity,
  "AWS.BedrockDataAutomation.GetDataAutomationLibraryEntity",
  (
    library: DataAutomationLibrary,
  ) => Effect.Effect<
    (
      request: GetDataAutomationLibraryEntityRequest,
    ) => Effect.Effect<
      bda.GetDataAutomationLibraryEntityResponse,
      bda.GetDataAutomationLibraryEntityError
    >
  >
> {}
export const GetDataAutomationLibraryEntity =
  Binding.Service<GetDataAutomationLibraryEntity>(
    "AWS.BedrockDataAutomation.GetDataAutomationLibraryEntity",
  );
