import { expect, it, vi } from "vite-plus/test";

const showBootError = vi.hoisted(() => vi.fn());
vi.mock("./lib/bootError", () => ({ showBootError }));
vi.mock("./main", () => ({
  get startup() {
    return Promise.reject(
      new TypeError("Failed to fetch dynamically imported module: /assets/main.js"),
    );
  },
}));

// Boots in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootWithFailedChunk(sessionStorage: Map<string, string>) {
  vi.resetModules();
  showBootError.mockClear();
  const reload = vi.fn().mockName("location.reload");
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => sessionStorage.set(key, value),
    },
    location: { reload },
  });
  try {
    await import("./bootstrap");
    await vi.waitFor(() =>
      expect(reload.mock.calls.length + showBootError.mock.calls.length).toBe(1),
    );
    return reload;
  } finally {
    vi.unstubAllGlobals();
  }
}

it("reloads once before showing the boot error when a startup chunk fails", async () => {
  const sessionStorage = new Map<string, string>();

  expect(await bootWithFailedChunk(sessionStorage)).toHaveBeenCalledTimes(1);
  expect(showBootError).not.toHaveBeenCalled();

  expect(await bootWithFailedChunk(sessionStorage)).not.toHaveBeenCalled();
  expect(showBootError).toHaveBeenCalledTimes(1);
});
