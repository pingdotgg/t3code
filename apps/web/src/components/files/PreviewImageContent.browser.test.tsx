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
  document.body.append(host);
  await using _screen = await render(
    <PreviewImageContent src={png(1600, 900)} name="wide.png" mimeType="image/png" />,
    { container: host },
  );
  const image = host.querySelector("img")!;

  // A wider image makes the pane scroll, and the scrollbar moves the centered image.
  const padding = 32;
  await vi.waitFor(() => {
    const width = image.getBoundingClientRect().width + padding;
    expect(width).toBeGreaterThan(499.5);
    expect(width).toBeLessThanOrEqual(500.5);
  });
});

it("fits the image by the layout size while a dialog scales the pane", async () => {
  const host = document.createElement("div");
  host.style.cssText =
    "display:flex;flex-direction:column;width:500px;height:600px;transform:scale(0.5)";
  document.body.append(host);
  await using _screen = await render(
    <PreviewImageContent src={png(1600, 900)} name="wide.png" mimeType="image/png" />,
    { container: host },
  );
  const image = host.querySelector("img")!;

  await vi.waitFor(() => expect(image.offsetWidth).toBe(468));
});
