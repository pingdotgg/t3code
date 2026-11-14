import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ModelPreviews from "./ModelPreviews.ts";

/** One binary STL triangle with the given far corner. */
function triangleStl(size = 10) {
  const bytes = new Uint8Array(84 + 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  [0, 0, 0, size, 0, 0, 0, 0, size * 2].forEach((value, index) =>
    view.setFloat32(96 + index * 4, value, true),
  );
  return bytes;
}

const layerTest = ModelPreviews.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("ModelPreviews", () => {
  it.effect("re-reads a file after it is saved again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previews = yield* ModelPreviews.ModelPreviews;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-previews-" });
      const filePath = path.join(directory, "part.stl");

      yield* fs.writeFile(filePath, triangleStl(10));
      const first = yield* previews.png(filePath);
      expect(first).not.toBeNull();
      expect(yield* previews.png(filePath)).toBe(first);

      yield* fs.writeFile(filePath, new Uint8Array(84));
      expect(yield* previews.png(filePath)).toBeNull();

      yield* fs.writeFile(filePath, triangleStl(-10));
      const resaved = yield* previews.png(filePath);
      expect(resaved).not.toBeNull();
      expect(resaved).not.toEqual(first);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns null for a different file than the one a token names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previews = yield* ModelPreviews.ModelPreviews;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-previews-" });
      const filePath = path.join(directory, "part.stl");
      yield* fs.writeFile(filePath, triangleStl());

      expect(yield* previews.png(filePath, { device: "0", inode: "0" })).toBeNull();
      expect(yield* previews.png(path.join(directory, "missing.stl"))).toBeNull();
      expect(yield* previews.png(path.join(directory, "notes.txt"))).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );
});
