// @effect-diagnostics nodeBuiltinImport:off - Tests the host-side image export files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, expect, it } from "@effect/vitest";
import { PNG } from "pngjs";

import {
  PEN_LAYOUTS,
  PEN_SCENES,
  penScreenshotFilename,
  preparePenAssets,
} from "./mobile-showcase-assets.ts";

const templateDirectory = NodeURL.fileURLToPath(
  new URL("./mobile-showcase-assets/", import.meta.url),
);
const assetsDirectory = "T3 Code AppStore Assets-assets";

it("keeps the G/H layouts and artwork intact while replacing all six matching captures", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pen-test-"));
  try {
    const input = NodePath.join(directory, "input");
    await NodeFSP.mkdir(input);
    const captures = PEN_SCENES.map(([, scene], index) => ({
      scene,
      bytes: PNG.sync.write(
        Object.assign(new PNG({ width: 1320, height: 2868 }), {
          data: Buffer.alloc(1320 * 2868 * 4, 20 + index),
        }),
        { colorType: 2, inputColorType: 6 },
      ),
    }));
    for (const capture of captures) {
      await NodeFSP.writeFile(NodePath.join(input, `${capture.scene}.png`), capture.bytes);
    }
    const originalDocument = await NodeFSP.readFile(
      NodePath.join(templateDirectory, "app-store.pen"),
    );
    const document = JSON.parse(originalDocument.toString()) as {
      children: Array<{ id: string; name: string; width: number; height: number }>;
    };
    for (const appearance of ["dark", "light"] as const) {
      const output = NodePath.join(directory, appearance);
      await preparePenAssets(input, output, appearance);
      assert.deepStrictEqual(
        await NodeFSP.readFile(NodePath.join(output, "app-store.pen")),
        originalDocument,
      );
      for (const [index, id] of PEN_LAYOUTS[appearance].entries()) {
        const frame = document.children.find((node) => node.id === id)!;
        assert.ok(frame.name.startsWith(`${appearance === "dark" ? "G" : "H"}0${index + 1}`));
        assert.equal(frame.width, 1290);
        assert.equal(frame.height, 2796);
      }
      for (const filename of await NodeFSP.readdir(
        NodePath.join(templateDirectory, assetsDirectory),
      )) {
        const scene = PEN_SCENES.find(
          ([asset]) => penScreenshotFilename(asset, appearance) === filename,
        )?.[1];
        const expected = scene
          ? captures.find((capture) => capture.scene === scene)!.bytes
          : await NodeFSP.readFile(NodePath.join(templateDirectory, assetsDirectory, filename));
        assert.deepStrictEqual(
          await NodeFSP.readFile(NodePath.join(output, assetsDirectory, filename)),
          expected,
        );
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("rejects missing and incorrectly sized captures instead of using the old screenshots", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pen-test-"));
  try {
    const input = NodePath.join(directory, "input");
    await NodeFSP.mkdir(input);
    await expect(
      preparePenAssets(input, NodePath.join(directory, "missing"), "dark"),
    ).rejects.toThrow(/ENOENT/u);
    await NodeFSP.writeFile(
      NodePath.join(input, "threads.png"),
      PNG.sync.write(new PNG({ width: 1, height: 1 }), { colorType: 2 }),
    );
    await expect(
      preparePenAssets(input, NodePath.join(directory, "wrong-size"), "light"),
    ).rejects.toThrow(/requires 1320×2868/u);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
