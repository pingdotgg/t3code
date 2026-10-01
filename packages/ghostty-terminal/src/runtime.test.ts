import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GhosttyRuntime, loadGhosttyRuntime } from "./runtime.ts";
import { testWasmSources } from "./testing/wasmSources.ts";

describe("loadGhosttyRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("instantiates the closure once per sources object", async () => {
    const instantiate = vi.spyOn(WebAssembly, "instantiate");
    const sources = { ...testWasmSources };
    const [first, second] = await Promise.all([
      loadGhosttyRuntime(sources),
      loadGhosttyRuntime(sources),
    ]);
    expect(second).toBe(first);
    expect(await loadGhosttyRuntime(sources)).toBe(first);
    // libghostty-vt plus the PTY trampoline, each exactly once.
    expect(instantiate).toHaveBeenCalledTimes(2);

    // The key is the object: a host that rebuilds its sources gets a second runtime.
    expect(await loadGhosttyRuntime({ ...testWasmSources })).not.toBe(first);
    expect(instantiate).toHaveBeenCalledTimes(4);
  });

  it("forgets a failed load so the next call retries", async () => {
    const load = vi.spyOn(GhosttyRuntime, "load");
    const broken = { vt: new Uint8Array([0, 97, 115, 109]), writePty: testWasmSources.writePty };
    await expect(loadGhosttyRuntime(broken)).rejects.toThrow();
    await expect(loadGhosttyRuntime(broken)).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
