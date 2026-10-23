import { render } from "pele";
import { describe, expect, it } from "vite-plus/test";

import { markdownWithMermaidDiagrams } from "./markdownDocument";
import { nativeMermaidSvg } from "./mermaidSvg";

const flowchart = "flowchart LR\n  A --> B";
const renderSource = (source: string) => source;

describe("mermaid fences in native markdown", () => {
  it("replaces a closed top-level fence with a standalone diagram image", () => {
    const { markdown, diagrams } = markdownWithMermaidDiagrams(
      `Before\n\`\`\`mermaid\n${flowchart}\n\`\`\`\nAfter`,
      renderSource,
    );
    expect(markdown).toBe("Before\n\n![Mermaid diagram](t3-mermaid:0)\n\nAfter");
    expect([...diagrams]).toEqual([["t3-mermaid:0", `${flowchart}`]]);
  });

  it("keys each diagram by its order in the message", () => {
    const fence = (source: string) => `~~~mermaid\n${source}\n~~~`;
    const { markdown, diagrams } = markdownWithMermaidDiagrams(
      `${fence("graph TD\n  A")}\n\n${fence("graph TD\n  B")}`,
      renderSource,
    );
    expect(markdown.match(/t3-mermaid:\d/g)).toEqual(["t3-mermaid:0", "t3-mermaid:1"]);
    expect([...diagrams.values()]).toEqual(["graph TD\n  A", "graph TD\n  B"]);
  });

  it("leaves a fence that is still streaming as code", () => {
    const streaming = "```mermaid\nflowchart LR\n  A --> B";
    expect(markdownWithMermaidDiagrams(streaming, renderSource).markdown).toBe(streaming);
    const longer = "````mermaid\nflowchart LR\n```";
    expect(markdownWithMermaidDiagrams(longer, renderSource).markdown).toBe(longer);
  });

  it("leaves diagrams outside media-slot positions and failed renders as code", () => {
    const nested = `- item\n\n  \`\`\`mermaid\n  ${flowchart}\n  \`\`\``;
    expect(markdownWithMermaidDiagrams(nested, renderSource).markdown).toBe(nested);
    const invalid = "```mermaid\nnot a diagram\n```";
    expect(markdownWithMermaidDiagrams(invalid, () => null)).toEqual({
      markdown: invalid,
      diagrams: new Map(),
    });
  });
});

describe("pele SVG for react-native-svg", () => {
  const palette = {
    background: "#101010",
    foreground: "#fafafa",
    muted: "#888888",
    surface: "rgba(250, 250, 250, 0.08)",
    surfaceAlt: "rgba(250, 250, 250, 0.16)",
    border: "rgba(250, 250, 250, 0.28)",
    accent: "#3b82f6",
    monoFontFamily: "Menlo",
  };

  it("inlines theme colors and root font size where native SVG can read them", () => {
    const svg = nativeMermaidSvg(
      render("flowchart TD\n subgraph outer\n  subgraph inner\n   A[Start] --> B{OK?}\n  end\n end")
        .svg,
      palette,
    );
    expect(svg).not.toMatch(/var\(|color-mix|--_/);
    const root = svg.slice(0, svg.indexOf(">"));
    expect(root).not.toContain("style=");
    expect(root).toContain('font-size="16"');
    expect(root).toContain('fill="#fafafa"');
    expect(root).toContain('color="#fafafa"');
    expect(svg).toContain('fill="rgba(250, 250, 250, 0.08)"');
    expect(svg).toContain('stroke="#888888"');
  });

  it("leaves label text that looks like CSS untouched", () => {
    const svg = nativeMermaidSvg(
      render(
        'flowchart TD\n A["var(--brand) > x"] --> B{"OK? var(--pele-fg"}\n B --> C["color-mix(in srgb, var(--a) 50%, var(--b))"]',
      ).svg,
      palette,
    );
    expect(svg).toContain(">var(--brand) &gt; x</text>");
    expect(svg).toContain(">OK? var(--pele-fg</text>");
    expect(svg).toContain(">color-mix(in srgb, var(--a)</tspan>");
    expect(svg).toContain(">50%, var(--b))</tspan>");
    expect(svg.replace(/<(text|tspan)[^>]*>[^<]*<\/\1>/g, "")).not.toMatch(/var\(|color-mix/);
  });

  it("resolves every attribute, including font weights, across diagram types", () => {
    for (const source of [
      "classDiagram\n A <|-- B",
      "gantt\n title T\n section S\n x :a1, 2024-01-01, 3d",
      "timeline\n title T\n 2020: a",
    ]) {
      const markup = nativeMermaidSvg(render(source).svg, palette)
        .match(/<[^>]*>/g)!
        .join("");
      expect(markup).not.toMatch(/var\(|color-mix|--_/);
    }
  });

  it("keeps Pele's fallback for colors the theme does not set", () => {
    const svg = nativeMermaidSvg(render('pie\n "Dogs" : 3\n "Cats" : 1').svg, palette);
    expect(svg).toContain('fill="#4c78a8"');
    expect(svg).not.toContain("var(");
  });
});
