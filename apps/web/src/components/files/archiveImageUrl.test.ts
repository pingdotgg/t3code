import { expect, it } from "vite-plus/test";

import { archiveImageUrl } from "./archiveImageUrl";

it("shows an archived SVG from a data URL", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  for (const path of ["art/logo.svg", "LOGO.SVG"]) {
    expect(archiveImageUrl(path, svg).url).toBe(
      `data:image/svg+xml;base64,${btoa(String.fromCharCode(...svg))}`,
    );
  }
  const png = archiveImageUrl("art/logo.png", new Uint8Array([137, 80, 78, 71]));
  expect(png.url).toMatch(/^blob:/);
  png.revoke();
});
