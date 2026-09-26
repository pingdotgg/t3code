import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Node has no dev server to fetch from; serve the same bytes as data URLs.
vi.mock("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm?url", async () => ({
  default: (await import("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm?inline")).default,
}));
vi.mock("@t3tools/ghostty-terminal/assets/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("@t3tools/ghostty-terminal/assets/ghostty-write-pty.wasm?inline")).default,
}));

describe("loadWebGhosttyRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("fetches and instantiates each WASM file once for every surface", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const instantiate = vi.spyOn(WebAssembly, "instantiate");
    const { loadWebGhosttyRuntime } = await import("./ghosttyAssets");

    const [drawer, preview] = await Promise.all([loadWebGhosttyRuntime(), loadWebGhosttyRuntime()]);
    expect(preview).toBe(drawer);
    expect(await loadWebGhosttyRuntime()).toBe(drawer);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(instantiate).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed fetch so the next surface retries", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { loadWebGhosttyRuntime } = await import("./ghosttyAssets");

    await expect(loadWebGhosttyRuntime()).rejects.toThrow("Unable to load libghostty-vt (503)");
    await expect(loadWebGhosttyRuntime()).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
