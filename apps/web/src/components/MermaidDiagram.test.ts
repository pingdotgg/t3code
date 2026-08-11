import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

import { renderMermaidDiagram } from "./MermaidDiagram";

describe("renderMermaidDiagram", () => {
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
  });

  it("renders with strict security and the selected theme", async () => {
    mermaid.render.mockResolvedValue({ svg: "<svg />" });

    await renderMermaidDiagram("diagram-1", "flowchart LR\nA-->B", "dark");

    expect(mermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "dark",
    });
    expect(mermaid.render).toHaveBeenCalledWith("diagram-1", "flowchart LR\nA-->B");
  });

  it("continues rendering after an invalid diagram", async () => {
    mermaid.render
      .mockRejectedValueOnce(new Error("Invalid diagram"))
      .mockResolvedValueOnce({ svg: "<svg />" });

    await expect(renderMermaidDiagram("diagram-1", "invalid", "light")).rejects.toThrow();
    await expect(
      renderMermaidDiagram("diagram-2", "sequenceDiagram\nA->>B: Hi", "light"),
    ).resolves.toEqual({ svg: "<svg />" });
  });
});
