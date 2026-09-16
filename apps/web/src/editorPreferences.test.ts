import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("resolveAndPersistPreferredEditor", () => {
  it("keeps an explicitly captured editor from falling back", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", storage);
    const { resolveAndPersistPreferredEditor } = await import("./editorPreferences");

    expect(resolveAndPersistPreferredEditor(["zed", "vscode"], "zed")).toBe("zed");
    expect(resolveAndPersistPreferredEditor(["vscode"], "zed")).toBeNull();
  });
});
