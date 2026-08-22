import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ImagePreview } from "@t3tools/opentui-image";
import * as React from "react";

import { deferMouseAction } from "../mouse.ts";
import { fitImageToCells, ImageLightbox } from "./ImageLightbox.tsx";

const PNG_SOURCE = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

function ImagePreviewTransition({ image }: { readonly image: ImagePreview }): React.ReactNode {
  const [expanded, setExpanded] = React.useState(false);
  const open = React.useMemo(() => deferMouseAction(() => setExpanded(true)), []);

  return expanded ? (
    <ImageLightbox
      preview={{ name: "diagram.png", sizeBytes: image.source.byteLength, image }}
      width={60}
      height={16}
      onClose={() => setExpanded(false)}
    />
  ) : (
    <box onMouseDown={open}>
      <image source={image.source} width={1} height={1} fit="fill" />
    </box>
  );
}

describe("ImageLightbox", () => {
  it("fits a wide image inside both terminal-cell bounds without distorting it", () => {
    expect(
      fitImageToCells({
        imageWidth: 1600,
        imageHeight: 900,
        maxColumns: 80,
        maxRows: 20,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ columns: 71, rows: 20 });
  });

  it("Given an expanded image, when the preview is clicked, then it closes", async () => {
    let closes = 0;
    const t = await testRender(
      <ImageLightbox
        preview={{
          name: "diagram.png",
          sizeBytes: 4096,
          image: {
            source: PNG_SOURCE,
            imageWidth: 1,
            imageHeight: 1,
          },
        }}
        width={60}
        height={16}
        onClose={() => {
          closes += 1;
        }}
      />,
      { width: 60, height: 16 },
    );
    await t.renderOnce();
    await t.flush();

    const frame = t.captureCharFrame();
    expect(frame).toContain("diagram.png · 4 KB");
    expect(frame).toContain("Esc / click to close");
    await t.mockMouse.click(3, 3);
    expect(closes).toBe(1);
    t.renderer.destroy();
  });

  it("Given an inline image, when it is repeatedly expanded and closed, then its renderable is replaced safely", async () => {
    const image = {
      source: PNG_SOURCE,
      imageWidth: 1,
      imageHeight: 1,
    };
    const t = await testRender(<ImagePreviewTransition image={image} />, {
      width: 60,
      height: 16,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await t.renderOnce();
      await React.act(() => t.mockMouse.click(0, 0));
      await t.flush();
      expect(t.captureCharFrame()).toContain("diagram.png · 1 KB");

      await React.act(() => t.mockMouse.click(3, 3));
      await t.flush();
      expect(t.captureCharFrame()).not.toContain("diagram.png · 1 KB");
    }

    t.renderer.destroy();
  });
});
