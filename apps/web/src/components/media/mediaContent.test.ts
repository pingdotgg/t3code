import { expect, it, vi } from "vite-plus/test";

import { readMediaPng } from "./mediaContent";

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

it("copies a data URL image without fetching it", async () => {
  // The desktop renderer's connect-src rejects data: URLs the way fetch rejects a CORS failure.
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("Failed to fetch"));
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

it("reports a malformed data URL instead of a fetch failure", async () => {
  await expect(readMediaPng("data:image/png;base64,%%%")).rejects.toThrow(
    "This inline media could not be decoded.",
  );
});
