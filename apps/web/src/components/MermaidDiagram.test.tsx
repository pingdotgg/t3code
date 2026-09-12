import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

import {
  MermaidDiagram,
  MermaidDiagramDialog,
  cacheRenderedDiagram,
  mermaidSvgNaturalSize,
  renderMermaidDiagram,
} from "./MermaidDiagram";
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
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "themeCSS",
        "fontFamily",
        "altFontFamily",
      ],
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

describe("MermaidDiagram expand", () => {
  const code = "flowchart LR\nExpandA-->ExpandB";

  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
    // Seeds the module-level SVG cache so SSR reads the rendered diagram
    // without running effects, exactly like a remount after scrolling.
    cacheRenderedDiagram("dark", code, "<svg>expanded-diagram</svg>");
  });

  it("renders the cached diagram as an expandable button carrying source for copy", () => {
    mermaid.render.mockClear();
    const html = renderToStaticMarkup(
      <MermaidDiagram code={code} theme="dark" fallback={<div>fallback</div>} />,
    );

    expect(mermaid.render).not.toHaveBeenCalled();
    expect(html).toContain("<svg>expanded-diagram</svg>");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Expand diagram"');
    expect(html).toContain("cursor-zoom-in");
    expect(html).toContain("data-markdown-copy");
    expect(html).toContain("flowchart LR");
    expect(html).not.toContain("fallback");
  });

  it("renders the expanded dialog scrollable with the same SVG and a source copy", () => {
    const html = renderToStaticMarkup(
      <MermaidDiagramDialog
        svg="<svg>expanded-diagram</svg>"
        copyMarkdown={serializeMarkdownCodeFence(code, "mermaid")}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("<svg>expanded-diagram</svg>");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("chat-markdown-mermaid-dialog");
    expect(html).toContain('aria-label="Close diagram preview"');
    expect(html).toContain('aria-label="Copy diagram source"');
    expect(html).toContain("data-markdown-copy");
  });
});

describe("mermaidSvgNaturalSize", () => {
  it("reads the natural size from the viewBox", () => {
    expect(
      mermaidSvgNaturalSize(
        '<svg width="100%" style="max-width: 444.89px;" viewBox="0 0 444.890625 174">',
      ),
    ).toEqual({ width: 444.890625, height: 174 });
  });

  it("rejects missing or degenerate viewBoxes", () => {
    expect(mermaidSvgNaturalSize("<svg>no viewBox</svg>")).toBeNull();
    expect(mermaidSvgNaturalSize('<svg viewBox="0 0 0 100">')).toBeNull();
    expect(mermaidSvgNaturalSize('<svg viewBox="nonsense">')).toBeNull();
  });
});

describe("MermaidDiagramDialog sizing", () => {
  it("fixes the scroll container to the diagram natural width", () => {
    const html = renderToStaticMarkup(
      <MermaidDiagramDialog
        svg='<svg viewBox="0 0 573.2 450"><g /></svg>'
        copyMarkdown="```mermaid\nflowchart\n```\n\n"
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("width:573.2px");
    expect(html).toContain("chat-markdown-mermaid-dialog");
  });
});

describe("MermaidDiagram visibility gating", () => {
  const code = "flowchart LR\nGatedA-->GatedB";

  it("defers rendering until the diagram nears the viewport", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    try {
      const html = renderToStaticMarkup(
        <MermaidDiagram code={code} theme="dark" fallback={<div>gated-fallback</div>} />,
      );

      expect(html).toContain("gated-fallback");
      expect(html).not.toContain('role="button"');
      expect(html).not.toContain("Expand diagram");
      // The fallback is wrapped in the observation host that triggers the
      // render on near-viewport entry. Bare fallback would be a single div.
      expect(html).toBe("<div><div>gated-fallback</div></div>");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
