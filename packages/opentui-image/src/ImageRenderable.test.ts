import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { ImageRenderable } from "./ImageRenderable.ts";
import { installKittyImageExtension } from "./KittyImageManager.ts";

describe("ImageRenderable", () => {
  it("participates in OpenTUI layout and submits a Kitty image after the frame", async () => {
    const t = await createTestRenderer({ width: 20, height: 8 });
    const writes: string[] = [];
    installKittyImageExtension(t.renderer, {
      capability: "always",
      writer: { write: (value) => writes.push(value) },
    });
    const image = new ImageRenderable(t.renderer, {
      data: new Uint8Array([255, 64, 32, 255]),
      imageWidth: 1,
      imageHeight: 1,
      columns: 3,
      rows: 2,
    });
    t.renderer.root.add(image);

    await t.renderOnce();

    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("c=3,r=2");
    t.renderer.destroy();
  });

  it("retransmits pixels mutated in place after invalidation", async () => {
    const t = await createTestRenderer({ width: 20, height: 8 });
    const writes: string[] = [];
    installKittyImageExtension(t.renderer, {
      capability: "always",
      writer: { write: (value) => writes.push(value) },
    });
    const data = new Uint8Array([1, 2, 3, 255]);
    const image = new ImageRenderable(t.renderer, {
      data,
      imageWidth: 1,
      imageHeight: 1,
    });
    t.renderer.root.add(image);
    await t.renderOnce();

    data[0] = 99;
    image.invalidate();
    await t.renderOnce();

    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatch(/a=d.*a=T/s);
    t.renderer.destroy();
  });

  it("preserves pixel aspect ratio when only a column limit is supplied", async () => {
    const t = await createTestRenderer({ width: 80, height: 24 });
    installKittyImageExtension(t.renderer, {
      capability: "always",
      writer: { write: () => undefined },
    });
    const image = new ImageRenderable(t.renderer, {
      data: new Uint8Array(100 * 100 * 4),
      imageWidth: 100,
      imageHeight: 100,
      columns: 10,
    });

    expect(image.width).toBe(10);
    expect(image.height).toBe(5);
    image.destroy();
    t.renderer.destroy();
  });
});
