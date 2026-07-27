import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { DIMENSIONS } from "./vectors.ts";

/**
 * Shared Vectorize resources used by BOTH the effect-worker and the
 * async-worker binding styles. Keeping one index here (instead of one per
 * worker) means both workers bind the SAME resource, so the driver test can
 * deploy both styles in a single stack and exercise the identical client
 * surface against shared data.
 *
 * Runtime-only vector helpers live in `vectors.ts` (no alchemy import) so the
 * plain async Worker can use them without bundling the Effect graph.
 */
export const TestIndex = Cloudflare.Vectorize.Index("VectorizeWorkerIndex", {
  dimensions: DIMENSIONS,
  metric: "cosine",
});

/**
 * Declares the metadata index on the `kind` property of the resolved parent
 * index. Must be yielded AFTER the parent index is resolved (its `indexName`
 * Output is only populated on the resolved resource, not the class handle).
 * Metadata indexes must exist before vectors are inserted for them to be
 * queryable, so the stack yields this before any worker upserts.
 */
export const ensureMetaIndex = Effect.fn(function* (
  index: Cloudflare.Vectorize.Index,
) {
  return yield* Cloudflare.Vectorize.MetadataIndex(
    "VectorizeWorkerKindMetaIndex",
    {
      indexName: index.indexName,
      propertyName: "kind",
      indexType: "string",
    },
  );
});
