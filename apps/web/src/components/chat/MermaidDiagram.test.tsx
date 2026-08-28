import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/lib/mermaidRenderer", () => ({
  renderMermaidSvg: vi.fn(),
}));

import { MermaidDiagram } from "./MermaidDiagram";

describe("MermaidDiagram", () => {
  it("shows a loading placeholder and mermaid source for copy until render completes", () => {
    const html = renderToStaticMarkup(
      <MermaidDiagram code={"flowchart TD\n  A --> B"} language="mermaid" theme="dark" />,
    );

    expect(html).toContain("Rendering diagram");
    expect(html).toContain("aria-busy");
    expect(html).toContain("```mermaid\nflowchart TD\n  A --&gt; B\n```");
  });
});
