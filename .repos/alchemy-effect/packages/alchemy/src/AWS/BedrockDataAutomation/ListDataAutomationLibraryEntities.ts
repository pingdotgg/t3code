import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationLibrary } from "./DataAutomationLibrary.ts";

/**
 * `ListDataAutomationLibraryEntities` request with `libraryArn` injected
 * from the bound {@link DataAutomationLibrary}.
 */
export interface ListDataAutomationLibraryEntitiesRequest extends Omit<
  bda.ListDataAutomationLibraryEntitiesRequest,
  "libraryArn"
> {}

/**
 * Runtime binding for the `ListDataAutomationLibraryEntities` operation (IAM
 * action `bedrock:ListDataAutomationLibraryEntities` on the library ARN) —
 * page through the bound library's entities of a given type from a deployed
 * Function.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.ListDataAutomationLibraryEntitiesHttp)`.
 * @binding
 * @section Library Entities
 * @example List Vocabulary Entities
 * ```typescript
 * // deploy time — bind the library
 * const listEntities =
 *   yield* AWS.BedrockDataAutomation.ListDataAutomationLibraryEntities(library);
 *
 * // runtime — first page of vocabulary entities
 * const { entities } = yield* listEntities({
 *   entityType: "VOCABULARY",
 *   maxResults: 25,
 * });
 * ```
 */
export interface ListDataAutomationLibraryEntities extends Binding.Service<
  ListDataAutomationLibraryEntities,
  "AWS.BedrockDataAutomation.ListDataAutomationLibraryEntities",
  (
    library: DataAutomationLibrary,
  ) => Effect.Effect<
    (
      request: ListDataAutomationLibraryEntitiesRequest,
    ) => Effect.Effect<
      bda.ListDataAutomationLibraryEntitiesResponse,
      bda.ListDataAutomationLibraryEntitiesError
    >
  >
> {}
export const ListDataAutomationLibraryEntities =
  Binding.Service<ListDataAutomationLibraryEntities>(
    "AWS.BedrockDataAutomation.ListDataAutomationLibraryEntities",
  );
