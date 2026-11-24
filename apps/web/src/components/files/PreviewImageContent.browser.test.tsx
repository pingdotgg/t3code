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

it("keeps a cached image out of view until it is fitted", async () => {
  const src = png(1600, 900);
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;width:500px;height:600px";
  const image = () => host.querySelector("img");
  await using screen = await render(
    <PreviewImageContent key="first" src={src} name="wide.png" mimeType="image/png" />,
    { container: host },
  );
  await vi.waitFor(() => expect(image()?.getBoundingClientRect().width).toBeGreaterThan(400));

  // A new key remounts the preview, as a new file revision does. The cached image has its natural
  // size on insertion, and the observer measures it before the load event can fit it.
  let insertedWidth: number | undefined;
  const mounts = new MutationObserver(() => {
    insertedWidth ??= image()?.getBoundingClientRect().width;
  });
  mounts.observe(host, { childList: true, subtree: true });
  await screen.rerender(
    <PreviewImageContent key="second" src={src} name="wide.png" mimeType="image/png" />,
  );
  mounts.disconnect();

  expect(insertedWidth).toBeLessThanOrEqual(500);
  await vi.waitFor(() => expect(image()?.getBoundingClientRect().width).toBeGreaterThan(400));
});
