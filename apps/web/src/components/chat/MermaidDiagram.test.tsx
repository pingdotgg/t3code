import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/lib/mermaidRenderer", () => ({
  renderMermaidSvg: vi.fn(),
  getCachedMermaidSvg: vi.fn(() => null),
}));

import { getCachedMermaidSvg } from "~/lib/mermaidRenderer";
import { MermaidDiagram } from "./MermaidDiagram";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    vi.mocked(getCachedMermaidSvg).mockReturnValue(null);
  });

  it("shows a loading placeholder and mermaid source for copy until render completes", () => {
    const html = renderToStaticMarkup(
      <MermaidDiagram code={"flowchart TD\n  A --> B"} language="mermaid" theme="dark" />,
    );

    expect(html).toContain("Rendering diagram");
    expect(html).toContain("aria-busy");
    expect(html).toContain("```mermaid\nflowchart TD\n  A --&gt; B\n```");
  });

  it("renders a cached diagram without the loading placeholder", () => {
    vi.mocked(getCachedMermaidSvg).mockReturnValue("<svg>cached</svg>");

    const html = renderToStaticMarkup(
      <MermaidDiagram code={"flowchart TD\n  A --> B"} language="mermaid" theme="dark" />,
    );

    expect(html).toContain("<svg>cached</svg>");
    expect(html).not.toContain("Rendering diagram");
  });
});
