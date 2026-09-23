import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openVsxExtensionExists } from "./openVsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openVsxExtensionExists", () => {
  it("reports whether Open VSX has the extension", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/ms-python/python")
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(openVsxExtensionExists("ms-python", "python")).resolves.toBe(true);
    await expect(openVsxExtensionExists("ms-vscode", "cpptools")).resolves.toBe(false);
  });

  it("fails when Open VSX is unavailable", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await expect(openVsxExtensionExists("demo", "theme")).rejects.toThrow(
      "Open VSX is unavailable right now.",
    );
  });
});
