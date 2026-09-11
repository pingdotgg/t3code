import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { initialize, render } = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: { initialize, render } }));

import { renderMermaidDiagram } from "./mermaidRendering";

describe("renderMermaidDiagram", () => {
  beforeEach(() => {
    initialize.mockReset();
    render.mockReset();
  });

  it("serializes diagrams so a second theme cannot change an active render", async () => {
    let finishFirst!: (value: { svg: string }) => void;
    const started = new Promise<void>((resolveStarted) => {
      render.mockImplementationOnce(() => {
        resolveStarted();
        return new Promise<{ svg: string }>((resolve) => {
          finishFirst = resolve;
        });
      });
    });
    render.mockResolvedValueOnce({ svg: "second" });
    const first = renderMermaidDiagram("graph TD; A-->B", "dark");
    const second = renderMermaidDiagram("graph TD; B-->C", "light");
    await started;
    expect(render).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: "dark",
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
      }),
    );
    finishFirst({ svg: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
    expect(render.mock.calls[0]?.[0]).not.toBe(render.mock.calls[1]?.[0]);
  });

  it("continues rendering after malformed input fails", async () => {
    render.mockRejectedValueOnce(new Error("Invalid diagram"));
    render.mockResolvedValueOnce({ svg: "valid" });
    await expect(renderMermaidDiagram("invalid", "light")).rejects.toThrow("Invalid diagram");
    await expect(renderMermaidDiagram("graph TD; A-->B", "light")).resolves.toBe("valid");
  });
});
