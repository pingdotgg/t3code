import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "~/index.css";
import PreviewImageContent from "./PreviewImageContent";

function png(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL("image/png");
}

it("fits the image inside a pane with a fractional width", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;width:500.5px;height:600px";
  await using _screen = await render(
    <PreviewImageContent src={png(1600, 900)} name="wide.png" mimeType="image/png" />,
    { container: host },
  );
  const image = host.querySelector("img")!;
  const padding = 32;

  await vi.waitFor(() => {
    const width = image.getBoundingClientRect().width + padding;
    expect(width).toBeGreaterThan(499.5);
    expect(width).toBeLessThanOrEqual(500.5);
  });
});
