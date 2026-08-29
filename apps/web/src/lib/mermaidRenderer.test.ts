import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaid,
}));

import {
  getCachedMermaidSvg,
  renderMermaidSvg,
  resetMermaidRendererForTests,
} from "./mermaidRenderer";

describe("renderMermaidSvg", () => {
  beforeEach(() => {
    resetMermaidRendererForTests();
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
  });

  it("initializes once per theme and returns the rendered svg", async () => {
    mermaid.render.mockResolvedValue({ svg: "<svg>ok</svg>" });

    await expect(renderMermaidSvg("flowchart TD\n  A --> B", "dark")).resolves.toBe(
      "<svg>ok</svg>",
    );
    await expect(renderMermaidSvg("flowchart TD\n  A --> C", "dark")).resolves.toBe(
      "<svg>ok</svg>",
    );

    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "dark",
      }),
    );
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("reinitializes when the theme changes", async () => {
    mermaid.render.mockResolvedValue({ svg: "<svg>ok</svg>" });

    await renderMermaidSvg("flowchart TD\n  A --> B", "dark");
    await renderMermaidSvg("flowchart TD\n  A --> B", "light");

    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "neutral" }),
    );
  });

  it("surfaces mermaid render failures", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error"));

    await expect(renderMermaidSvg("not a diagram", "dark")).rejects.toThrow("Parse error");
    expect(getCachedMermaidSvg("not a diagram", "dark")).toBeNull();
  });

  it("returns a cached svg without rendering again", async () => {
    mermaid.render.mockResolvedValue({ svg: "<svg>ok</svg>" });

    await renderMermaidSvg("flowchart TD\n  A --> B", "dark");
    mermaid.render.mockClear();

    await expect(renderMermaidSvg("flowchart TD\n  A --> B", "dark")).resolves.toBe(
      "<svg>ok</svg>",
    );
    expect(getCachedMermaidSvg("flowchart TD\n  A --> B", "dark")).toBe("<svg>ok</svg>");
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
