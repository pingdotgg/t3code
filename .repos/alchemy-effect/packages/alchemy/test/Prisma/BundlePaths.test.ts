import { normalizeBundleFilePath } from "@/Prisma/Internal/BundlePaths";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("Prisma Compute bundle paths", () => {
  it.effect("accepts normalized relative bundle paths", () =>
    Effect.gen(function* () {
      expect(yield* normalizeBundleFilePath("chunks/api.js")).toBe(
        "chunks/api.js",
      );
    }),
  );

  it.effect("rejects empty, absolute, and traversal bundle paths", () =>
    Effect.gen(function* () {
      for (const path of [
        "",
        "/tmp/escape.js",
        "C:\\tmp\\escape.js",
        "../escape.js",
        "chunks/../../escape.js",
        "chunks//escape.js",
      ]) {
        const error = yield* normalizeBundleFilePath(path).pipe(Effect.flip);
        expect(error).toBeInstanceOf(Error);
      }
    }),
  );
});
