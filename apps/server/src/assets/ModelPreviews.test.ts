import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ModelPreviews from "./ModelPreviews.ts";

/** A legacy 64-bit header followed by a 2x1 thumbnail with the given pixels. */
function blendWithPixels(left: ReadonlyArray<number>, right: ReadonlyArray<number>) {
  const blend = new Uint8Array(12 + 24 + 16);
  blend.set(new TextEncoder().encode("BLENDER-v300TEST"));
  const view = new DataView(blend.buffer);
  view.setInt32(16, 16, true);
  view.setInt32(36, 2, true);
  view.setInt32(40, 1, true);
  blend.set([...left, ...right], 44);
  return blend;
}

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

const layerWithBlender = (
  blender: ModelPreviews.ModelPreviewsOptions["blender"],
  baseDir: string | { readonly prefix: string } = { prefix: "t3-model-previews-test-" },
) =>
  ModelPreviews.layerWith({ blender }).pipe(
    Layer.provideMerge(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
const layerTest = layerWithBlender("off");

describe("ModelPreviews", () => {
  it.effect("re-reads a Blender thumbnail after the file is saved again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previews = yield* ModelPreviews.ModelPreviews;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-previews-" });
      const filePath = path.join(directory, "scene.blend");

      yield* fs.writeFile(filePath, blendWithPixels([255, 0, 0, 255], [0, 0, 0, 255]));
      const first = yield* previews.png(filePath);
      expect(first).not.toBeNull();
      expect(yield* previews.png(filePath)).toBe(first);

      yield* fs.writeFile(filePath, new TextEncoder().encode("BLENDER-v300ENDB"));
      expect(yield* previews.png(filePath)).toBeNull();

      yield* fs.writeFile(filePath, blendWithPixels([0, 0, 255, 255], [0, 0, 0, 255]));
      const resaved = yield* previews.png(filePath);
      expect(resaved).not.toBeNull();
      expect(resaved).not.toEqual(first);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs Blender once per revision for both the render and the geometry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-previews-" });
        const filePath = path.join(directory, "scripted.blend");
        yield* fs.writeFile(filePath, blendWithPixels([0, 0, 0, 255], [0, 0, 0, 255]));
        const runs = path.join(directory, "runs");
        // Stands in for Blender: records each run and writes the outputs named after `--`.
        const fakeBlender = (name: string, outputs: string) =>
          Effect.gen(function* () {
            const blender = path.join(directory, name);
            yield* fs.writeFileString(
              blender,
              `#!/bin/sh\necho run >> "${runs}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\n${outputs}\n`,
            );
            yield* fs.chmod(blender, 0o755);
            return blender;
          });
        const blender = yield* fakeBlender(
          "blender",
          `printf 'ply' > "$1"; printf 'rendered' > "$2"`,
        );
        const both = (blenderPath: string) =>
          Effect.gen(function* () {
            const previews = yield* ModelPreviews.ModelPreviews;
            return {
              png: yield* previews.png(filePath),
              geometry: yield* previews.blendGeometry(filePath),
            };
          }).pipe(Effect.provide(layerWithBlender({ path: blenderPath }, directory)));

        const first = yield* both(blender);
        expect(new TextDecoder().decode(first.png!)).toBe("rendered");
        expect(yield* fs.readFileString(first.geometry!)).toBe("ply");
        // A new server reuses the outputs saved on disk instead of running Blender again.
        expect(yield* both(blender)).toEqual(first);
        expect((yield* fs.readFileString(runs)).trim().split("\n")).toHaveLength(1);

        // Past the triangle limit Blender writes only the render, and that run still counts.
        const tooLarge = yield* fakeBlender("too-large", `printf 'rendered' > "$2"`);
        yield* fs.writeFile(filePath, blendWithPixels([0, 0, 0, 255], [0, 0, 0, 255]));
        const large = yield* both(tooLarge);
        expect(large.png).not.toBeNull();
        expect(large.geometry).toBeNull();
        expect((yield* fs.readFileString(runs)).trim().split("\n")).toHaveLength(2);

        const failing = yield* fakeBlender("failing", "exit 1");
        yield* fs.writeFile(filePath, blendWithPixels([0, 0, 0, 255], [0, 0, 0, 255]));
        expect(yield* both(failing)).toEqual({ png: null, geometry: null });
        expect(
          yield* Effect.gen(function* () {
            const previews = yield* ModelPreviews.ModelPreviews;
            return yield* previews.blendGeometry(filePath);
          }).pipe(Effect.provide(layerWithBlender("off", directory))),
        ).toBeNull();
        const stlPath = path.join(directory, "part.stl");
        yield* fs.writeFile(stlPath, triangleStl());
        expect(
          yield* Effect.gen(function* () {
            const previews = yield* ModelPreviews.ModelPreviews;
            return yield* previews.blendGeometry(stlPath);
          }).pipe(Effect.provide(layerWithBlender({ path: blender }, directory))),
        ).toBeNull();
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-renders a mesh after it is saved again", () =>
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
      const filePath = path.join(directory, "scene.blend");
      yield* fs.writeFile(filePath, blendWithPixels([255, 0, 0, 255], [0, 0, 0, 255]));

      expect(yield* previews.png(filePath, { device: "0", inode: "0" })).toBeNull();
      expect(yield* previews.png(path.join(directory, "missing.blend"))).toBeNull();
      expect(yield* previews.png(path.join(directory, "notes.txt"))).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );
});
