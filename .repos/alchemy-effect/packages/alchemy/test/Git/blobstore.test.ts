import { orderedParts } from "@/Git/BlobStore.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { makeMemoryBlobStore } from "./harness/store.ts";

describe("multipart parts", () => {
  test("orderedParts sorts by part number regardless of settle order", () => {
    // The push pipeline's hasher isolates upload parts concurrently and the
    // small tail settles before earlier parts do.
    const parts = [1, 3, 6, 2, 5, 4].map((partNumber) => ({
      partNumber,
      etag: `e${partNumber}`,
    }));
    expect(orderedParts(parts).map((p) => p.partNumber)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });
  test("the memory store enforces R2's uniform-part rule as R2 does", async () => {
    const blobs = makeMemoryBlobStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const upload = yield* blobs.multipart("k");
        const parts = [
          yield* blobs.uploadPart("k", upload.uploadId, 1, new Uint8Array(8)),
          yield* blobs.uploadPart("k", upload.uploadId, 3, new Uint8Array(3)),
          yield* blobs.uploadPart("k", upload.uploadId, 2, new Uint8Array(8)),
        ];
        // As given: [1, 3, 2] puts the small part in the middle → rejected.
        const unsorted = yield* Effect.result(upload.complete(parts));
        const sorted = yield* Effect.result(
          upload.complete(orderedParts(parts)),
        );
        const head = yield* blobs.head("k");
        return {
          unsorted: unsorted._tag,
          sorted: sorted._tag,
          size: head?.size,
        };
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
    expect(result.unsorted).toBe("Failure");
    expect(result.sorted).toBe("Success");
    expect(result.size).toBe(19);
  });
});
