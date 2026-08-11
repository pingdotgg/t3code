import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

import { renderMermaidDiagram } from "./MermaidDiagram";
import { serializeMarkdownCodeFence } from "../markdown-clipboard";

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

  it("skips queued work after its diagram unmounts", async () => {
    let finishFirstRender!: (result: { svg: string }) => void;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstRender = resolve;
        }),
    );

    const first = renderMermaidDiagram("diagram-1", "flowchart LR\nA-->B", "light");
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    const second = renderMermaidDiagram("diagram-2", "flowchart LR\nB-->C", "light", () => false);
    finishFirstRender({ svg: "<svg />" });

    await first;
    await expect(second).resolves.toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("chooses a fence longer than backtick runs in copied source", () => {
    expect(serializeMarkdownCodeFence("flowchart LR\n%% ``` in a comment", "mermaid")).toBe(
      "````mermaid\nflowchart LR\n%% ``` in a comment\n````\n\n",
    );
  });
});
