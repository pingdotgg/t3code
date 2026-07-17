import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
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

  it("removes an image after its containing row scrolls outside the clipped viewport", async () => {
    const t = await createTestRenderer({ width: 20, height: 8 });
    const writes: string[] = [];
    installKittyImageExtension(t.renderer, {
      capability: "always",
      writer: { write: (value) => writes.push(value) },
    });
    const scrollbox = new ScrollBoxRenderable(t.renderer, { width: 10, height: 2 });
    const row = new BoxRenderable(t.renderer, {
      width: 10,
      height: 6,
      flexShrink: 0,
      flexDirection: "column",
    });
    row.add(
      new ImageRenderable(t.renderer, {
        data: new Uint8Array(2 * 2 * 4),
        imageWidth: 2,
        imageHeight: 2,
        columns: 2,
        rows: 2,
      }),
    );
    scrollbox.add(row);
    t.renderer.root.add(scrollbox);

    await t.renderOnce();
    expect(writes.join("")).toContain("a=T");

    scrollbox.scrollTo(4);
    await t.renderOnce();

    expect(writes.at(-1)).toContain("a=d");
    expect(writes.at(-1)).not.toContain("a=T");
    t.renderer.destroy();
  });

  it("crops a partially visible image to the scroll viewport", async () => {
    const t = await createTestRenderer({ width: 20, height: 8 });
    const writes: string[] = [];
    installKittyImageExtension(t.renderer, {
      capability: "always",
      writer: { write: (value) => writes.push(value) },
    });
    const scrollbox = new ScrollBoxRenderable(t.renderer, { width: 10, height: 1 });
    const row = new BoxRenderable(t.renderer, {
      width: 10,
      height: 3,
      flexShrink: 0,
      flexDirection: "column",
    });
    row.add(
      new ImageRenderable(t.renderer, {
        data: new Uint8Array(2 * 2 * 4),
        imageWidth: 2,
        imageHeight: 2,
        columns: 2,
        rows: 2,
      }),
    );
    scrollbox.add(row);
    t.renderer.root.add(scrollbox);
    await t.renderOnce();
    writes.length = 0;
    scrollbox.scrollTo(1);

    await t.renderOnce();

    expect(writes.join("")).toContain("x=0,y=1,w=2,h=1,c=2,r=1,C=1");
    t.renderer.destroy();
  });

  it("renders an in-buffer placeholder while Kitty placements are paused for scrolling", async () => {
    const t = await createTestRenderer({ width: 40, height: 8 });
    const writes: string[] = [];
    const manager = installKittyImageExtension(t.renderer, {
      capability: "always",
      writer: { write: (value) => writes.push(value) },
    });
    t.renderer.root.add(
      new ImageRenderable(t.renderer, {
        data: new Uint8Array(2 * 2 * 4),
        imageWidth: 2,
        imageHeight: 2,
        columns: 34,
        rows: 3,
      }),
    );
    await t.renderOnce();

    manager.pauseForScroll(10_000);
    await t.renderOnce();

    expect(t.captureCharFrame()).toContain("[ image paused while scrolling ]");
    expect(writes.at(-1)).toContain("a=d");
    manager.resumeAfterScroll();
    t.renderer.destroy();
  });

  it("uses tmux-positioned Unicode cells instead of the outer terminal cursor", async () => {
    const t = await createTestRenderer({ width: 20, height: 8 });
    const writes: string[] = [];
    installKittyImageExtension(t.renderer, {
      capability: "always",
      tmuxPassthrough: true,
      writer: { write: (value) => writes.push(value) },
    });
    setRendererCapabilities(t.renderer, {
      kitty_graphics: false,
      multiplexer: "tmux",
    });
    const row = new BoxRenderable(t.renderer, {
      width: 10,
      height: 5,
      paddingLeft: 3,
      paddingTop: 2,
    });
    row.add(
      new ImageRenderable(t.renderer, {
        data: new Uint8Array(2 * 2 * 4),
        imageWidth: 2,
        imageHeight: 2,
        columns: 2,
        rows: 2,
      }),
    );
    t.renderer.root.add(row);

    await t.renderOnce();
    expect(writes.join("")).toContain("a=T,U=1");
    expect(t.captureCharFrame()).not.toContain("\u{10eeee}");
    await t.renderOnce();

    expect(writes.join("")).not.toContain("\x1b[3;4H");
    const frame = t.captureCharFrame().split("\n");
    expect(frame[2]?.codePointAt(3)).toBe(0x10eeee);
    t.renderer.destroy();
  });
});
