import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

import {
  constrainMermaidTransform,
  mermaidTransformStyle,
  panMermaidTransform,
  renderMermaidDiagram,
  zoomMermaidTransform,
} from "./MermaidDiagram";

describe("renderMermaidDiagram", () => {
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
  });

  it("uses Mermaid strict mode and the selected theme", async () => {
    mermaid.render.mockResolvedValue({ svg: "<svg />", diagramType: "flowchart-v2" });

    await expect(renderMermaidDiagram("diagram-1", "flowchart LR\nA-->B", "dark")).resolves.toEqual(
      {
        svg: "<svg />",
        diagramType: "flowchart-v2",
      },
    );

    expect(mermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "dark",
      darkMode: true,
      fontFamily: "var(--font-sans)",
      logLevel: "fatal",
    });
    expect(mermaid.render).toHaveBeenCalledWith("diagram-1", "flowchart LR\nA-->B");
  });

  it("continues the render queue after a diagram fails", async () => {
    mermaid.render
      .mockRejectedValueOnce(new Error("Invalid diagram"))
      .mockResolvedValueOnce({ svg: "<svg />", diagramType: "sequence" });

    await expect(renderMermaidDiagram("diagram-1", "invalid", "light")).rejects.toThrow(
      "Invalid diagram",
    );
    await expect(
      renderMermaidDiagram("diagram-2", "sequenceDiagram\nA->>B: Hi", "light"),
    ).resolves.toEqual({ svg: "<svg />", diagramType: "sequence" });

    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });
});

describe("Mermaid viewport transforms", () => {
  it("clamps zoom between 50 and 300 percent", () => {
    expect(zoomMermaidTransform({ x: 10, y: 20, scale: 1 }, -2)).toEqual({
      x: 10,
      y: 20,
      scale: 0.5,
    });
    expect(zoomMermaidTransform({ x: 10, y: 20, scale: 1 }, 5)).toEqual({
      x: 10,
      y: 20,
      scale: 3,
    });
  });

  it("updates pan coordinates and formats the CSS transform", () => {
    const transform = panMermaidTransform({ x: 0, y: 0, scale: 1.25 }, 48, -24);

    expect(transform).toEqual({ x: 48, y: -24, scale: 1.25 });
    expect(mermaidTransformStyle(transform)).toBe("translate(48px, -24px) scale(1.25)");
  });

  it("limits pan to the scaled diagram edges", () => {
    const bounds = {
      viewportWidth: 200,
      viewportHeight: 100,
      contentWidth: 400,
      contentHeight: 200,
    };

    expect(constrainMermaidTransform({ x: 1_000, y: -1_000, scale: 2 }, bounds)).toEqual({
      x: 300,
      y: -150,
      scale: 2,
    });
  });

  it("centers a diagram that is smaller than its viewport", () => {
    expect(
      constrainMermaidTransform(
        { x: 120, y: -80, scale: 0.5 },
        {
          viewportWidth: 500,
          viewportHeight: 300,
          contentWidth: 400,
          contentHeight: 200,
        },
      ),
    ).toEqual({ x: 0, y: 0, scale: 0.5 });
  });
});
