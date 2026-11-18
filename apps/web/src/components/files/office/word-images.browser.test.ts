import { expect, it } from "vite-plus/test";
import { createBitmapImageResolver } from "./word-images";

it("asks the window to rasterize SVG pictures at their drawn size, and draws the bitmaps it returns", async () => {
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const images = createBitmapImageResolver(() => ({ bytes: svg, mimeType: "image/svg+xml" }));
  const sizes = new Map([["media:1", { width: 40, height: 20 }]]);

  expect(await images.resolve("media:1")).toBeNull();

  const [request, ...rest] = images.vectors(sizes);

  expect(rest).toEqual([]);
  expect(request).toMatchObject({ asset: "media:1", size: { width: 40, height: 20 } });

  const bitmap = await createImageBitmap(new ImageData(40, 20));

  images.provide([{ asset: "media:1", bitmap }]);

  expect(await images.resolve("media:1")).toBe(bitmap);
  expect(images.vectors(sizes)).toEqual([]);
});
