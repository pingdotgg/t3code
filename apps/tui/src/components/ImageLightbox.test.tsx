import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";

import { fitImageToCells, ImageLightbox } from "./ImageLightbox.tsx";

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
            data: new Uint8Array([255, 0, 0, 255]),
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
});
