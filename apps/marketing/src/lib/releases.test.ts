import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease } from "./releases";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestRelease", () => {
  it("rejects a GitHub API error response instead of returning it as a release", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    vi.stubGlobal("fetch", async () =>
      Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
    );

    await expect(fetchLatestRelease("stable")).rejects.toThrow("403");
  });
});
