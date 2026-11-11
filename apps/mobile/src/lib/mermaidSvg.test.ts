import { render } from "pele";
import { describe, expect, it } from "vite-plus/test";

import { mermaidSvgForNative, withDiagramBackground } from "./mermaidSvg";

describe("mermaidSvgForNative", () => {
  it("turns Pele's CSS variables and styles into attributes react-native-svg draws", () => {
    const { svg } = render(
      'flowchart LR\n  A[Client] -->|ws| B(Server)\n  B --> C["var(--pele-fg)"]',
      {
        links: false,
        images: false,
      },
    );

    const native = mermaidSvgForNative(svg, {
      "--pele-fg": "#111111",
      "--pele-line": "#222222",
      "--pele-font": "Helvetica",
    });

    expect(native).not.toMatch(/="[^"]*var\(|style=/);
    // A label that reads like a variable keeps its text.
    expect(native).toContain(">var(--pele-fg)<");
    expect(native).toMatch(
      /^<svg[^>]* fill="#111111"[^>]* font-family="Helvetica" font-size="16">/,
    );
    expect(native).toContain('stroke="#222222"');
    // Colors the theme leaves out keep Pele's fallback, and the corner radius becomes geometry.
    expect(native).toContain('fill="#f3f3f3"');
    expect(native).toMatch(/<rect[^>]* rx="4"/);
    // The exported image fills the viewBox before anything else draws.
    expect(withDiagramBackground(native, "#fafafa")).toMatch(
      /^<svg[^>]*><rect x="0" y="0" width="\d+(\.\d+)?" height="\d+(\.\d+)?" fill="#fafafa"\/>/,
    );
  });
});
