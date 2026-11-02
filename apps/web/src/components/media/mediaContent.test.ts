import { expect, it, vi } from "vite-plus/test";

import { readMediaPng } from "./mediaContent";

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

it("copies a data URL image without fetching it", async () => {
  // The desktop renderer's connect-src rejects data: URLs the way fetch rejects a CORS failure.
  using fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const src = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;

  const png = await readMediaPng(src);

  expect(fetch).not.toHaveBeenCalled();
  expect(png.type).toBe("image/png");
  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it("decodes percent-escaped bytes in a non-base64 data URL", async () => {
  const escaped = PNG_BYTES.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const src = `data:image/png,${escaped}`;

  const png = await readMediaPng(src);

  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it("accepts any case in the scheme and base64 marker, and escapes in base64", async () => {
  const base64 = btoa(String.fromCharCode(...PNG_BYTES)).replaceAll("=", "%3D");

  const png = await readMediaPng(`DATA:image/png;BASE64,${base64}`);

  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it("ignores the URL fragment when decoding a data URL", async () => {
  const src = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}#preview`;

  const png = await readMediaPng(src);

  expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG_BYTES);
});

it.each(["data:image/png;base64,%%%", "data:image/png"])(
  "reports malformed inline media: %s",
  async (src) => {
    await expect(readMediaPng(src)).rejects.toThrow("This inline media could not be decoded.");
  },
);

it("keeps remote media on the fetch path", async () => {
  const png = new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" });
  using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png));

  expect(await readMediaPng("https://example.com/image.png")).toEqual(png);
  expect(fetch).toHaveBeenCalledWith("https://example.com/image.png");
});
