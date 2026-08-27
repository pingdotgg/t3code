// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  copyGeneratedImage,
  createGeneratedImageId,
  parseGeneratedImageId,
  resolveGeneratedImagePath,
  writeGeneratedImage,
} from "./imageStore.ts";

describe("imageStore", () => {
  it("creates image ids that stay inside the images directory", () => {
    const imageId = createGeneratedImageId(".png");
    expect(imageId).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(parseGeneratedImageId(imageId ?? "")?.extension).toBe(".png");
    expect(parseGeneratedImageId("../secret.png")).toBeNull();
  });

  it("writes and copies files under the images directory", () => {
    const imagesDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-images-"));
    const imageId = createGeneratedImageId(".jpg");
    expect(imageId).toBeTruthy();
    const written = writeGeneratedImage({
      imagesDir,
      imageId: imageId!,
      bytes: Uint8Array.from([0xff, 0xd8, 0xff]),
    });
    expect(written).toBe(resolveGeneratedImagePath({ imagesDir, imageId: imageId! }));
    expect(NodeFS.readFileSync(written!).length).toBe(3);

    const copyId = createGeneratedImageId("png")!;
    const copied = copyGeneratedImage({
      imagesDir,
      imageId: copyId,
      sourcePath: written!,
    });
    expect(copied).toContain(copyId);
    expect(NodeFS.readFileSync(copied!).length).toBe(3);
  });
});
