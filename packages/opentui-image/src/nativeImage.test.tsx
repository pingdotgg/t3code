import { describe, expect, it } from "bun:test";
import { ImageRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import * as NodeBuffer from "node:buffer";
import * as React from "react";

import { decodeImage } from "./decodeImage.ts";

const ONE_PIXEL_PNG = NodeBuffer.Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("native OpenTUI image", () => {
  it("renders a decoded preview by passing its encoded source directly to OpenTUI", async () => {
    const preview = (await decodeImage(ONE_PIXEL_PNG)) as unknown as {
      readonly source: Uint8Array;
    };
    const t = await testRender(
      React.createElement("image", {
        id: "preview",
        source: preview.source,
        width: 4,
        height: 2,
        fit: "fill",
      }),
      { width: 12, height: 5 },
    );
    await t.waitFor(() => {
      const image = t.renderer.root.findDescendantById("preview");
      return image instanceof ImageRenderable && !image.loading;
    });
    await t.renderOnce();

    const [firstRow, secondRow] = t.captureCharFrame().split("\n");
    expect(firstRow).toStartWith("████");
    expect(secondRow).toStartWith("████");
    await React.act(async () => t.renderer.destroy());
  });
});
