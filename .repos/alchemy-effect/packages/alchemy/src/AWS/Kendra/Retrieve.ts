import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `Retrieve` request with `IndexId` injected from the bound index.
 */
export interface RetrieveRequest extends Omit<
  kendra.RetrieveRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `Retrieve` operation (IAM action
 * `kendra:Retrieve`), scoped to one {@link Index}.
 *
 * Retrieves up to 100 semantically-relevant passages (200-token excerpts)
 * from the index — the building block for retrieval-augmented generation
 * (RAG) over documents synced into Kendra.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.RetrieveHttp)`.
 *
 * @binding
 * @section Querying an Index
 * @example Retrieve Passages for RAG
 * ```typescript
 * const retrieve = yield* AWS.Kendra.Retrieve(index);
 *
 * const passages = yield* retrieve({ QueryText: "vacation policy" });
 * const context = (passages.ResultItems ?? [])
 *   .map((item) => item.Content)
 *   .join("\n");
 * ```
 */
export interface Retrieve extends Binding.Service<
  Retrieve,
  "AWS.Kendra.Retrieve",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: RetrieveRequest,
    ) => Effect.Effect<kendra.RetrieveResult, kendra.RetrieveError>
  >
> {}
export const Retrieve = Binding.Service<Retrieve>("AWS.Kendra.Retrieve");
