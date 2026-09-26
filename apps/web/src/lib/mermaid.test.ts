import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: mocks.initialize, render: mocks.render },
}));

const { getCachedMermaidSvg, renderMermaidSvg } = await import("./mermaid");

beforeEach(() => {
  mocks.initialize.mockClear();
  mocks.render.mockClear();
  mocks.render.mockImplementation((_id: string, code: string) =>
    Promise.resolve({ svg: `<svg data-code="${code}" />` }),
  );
});

describe("renderMermaidSvg", () => {
  it("renders once and serves repeats from the cache", async () => {
    const code = "graph TD; cached-->once;";
    expect(getCachedMermaidSvg(code, "dark")).toBeNull();

    const first = await renderMermaidSvg(code, "dark");
    const second = await renderMermaidSvg(code, "dark");

    expect(first).toBe(second);
    expect(getCachedMermaidSvg(code, "dark")).toBe(first);
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent renders of the same diagram", async () => {
    const code = "graph TD; concurrent-->once;";

    const [first, second] = await Promise.all([
      renderMermaidSvg(code, "dark"),
      renderMermaidSvg(code, "dark"),
    ]);

    expect(first).toBe(second);
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it("caches per theme and reconfigures mermaid when the theme changes", async () => {
    const code = "graph TD; themed-->twice;";

    const dark = await renderMermaidSvg(code, "dark");
    const light = await renderMermaidSvg(code, "light");

    expect(getCachedMermaidSvg(code, "dark")).toBe(dark);
    expect(getCachedMermaidSvg(code, "light")).toBe(light);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(mocks.initialize.mock.calls.at(-1)?.[0]).toMatchObject({ theme: "default" });
  });

  it("keeps rendering after a diagram fails to parse", async () => {
    mocks.render.mockRejectedValueOnce(new Error("Parse error on line 2"));

    await expect(renderMermaidSvg("graph TD; broken", "light")).rejects.toThrow(
      "Parse error on line 2",
    );
    await expect(renderMermaidSvg("graph TD; ok-->after;", "light")).resolves.toContain("<svg");
  });
});
