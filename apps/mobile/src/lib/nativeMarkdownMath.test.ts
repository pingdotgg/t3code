import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { parseNativeMarkdownMath } from "../../modules/t3-markdown-text/src/nativeMarkdownMath";
import {
  nativeMathSvg,
  nativeMathRunHtml,
} from "../../modules/t3-markdown-text/src/nativeMathHtml";
import {
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
} from "../../modules/t3-markdown-text/src/nativeMarkdownText";

const textStyle = {
  color: "#fff",
  strongColor: "#fff",
  mutedColor: "#aaa",
  linkColor: "#acf",
  inlineCodeColor: "#fff",
  codeColor: "#fff",
  codeBackgroundColor: "#111",
  codeBlockBackgroundColor: "#111",
  fileTextColor: "#fff",
  skillTextColor: "#fff",
  quoteMarkerColor: "#888",
  dividerColor: "#444",
  fontSize: 15,
  lineHeight: 22,
  fontFamily: "system-ui",
  headingFontFamily: "system-ui",
  boldFontFamily: "system-ui",
};

describe("native math", () => {
  it("uses shared math recognition and keeps code and currency literal", () => {
    let input = "";
    const source = String.raw`Use \(x_i\), keep ` + "`$code$` and pay $20 or $30.";
    const tree = parseNativeMarkdownMath(source, (markdown) => {
      input = markdown;
      return { type: "paragraph", children: [{ type: "text", content: ":t3-math-0:" }] };
    });
    expect(input).toContain(":t3-math-0:");
    expect(input).toContain("`$code$`");
    expect(input).toContain("$20 or $30");
    expect(nativeMarkdownDocumentRuns(tree)).toEqual([
      { text: String.raw`\(x_i\)`, mathSource: String.raw`\(x_i\)`, role: "body" },
    ]);
  });

  it.each([
    String.raw`$x_i^2+\alpha$`,
    String.raw`\(\frac{a}{b}\)`,
    String.raw`$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`,
    String.raw`\[\begin{aligned}x&=1\\y&=2\end{aligned}\]`,
  ])("produces a self-contained equation for %s", (source) => {
    const svg = nativeMathSvg(source);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).not.toContain("<use");
    expect(svg).not.toContain("merror");
    expect(svg).toContain("<math");
  });

  it("falls back for malformed expressions and isolates macros", () => {
    expect(nativeMathSvg(String.raw`$\frac{$`)).toBeNull();
    nativeMathSvg(String.raw`$\gdef\privateMacro{x}\privateMacro$`);
    expect(nativeMathSvg(String.raw`$\privateMacro$`)).toBeNull();
  });

  it("keeps original TeX in the selection-copy contract", () => {
    const source = String.raw`\[x < y\]`;
    const html = nativeMathRunHtml({ text: source, mathSource: source }, textStyle);
    expect(html).toContain('data-source="\\[x &lt; y\\]"');
    expect(html).toContain('data-copy="\\[x &lt; y\\]"');
  });
});

it("preserves heading context on inline math and uses native layout for math lists", () => {
  const math = { type: "math_inline", content: "$x$" } as const;
  const heading = nativeMarkdownDocumentRuns({ type: "heading", level: 2, children: [math] });
  expect(heading[0]).toMatchObject({ mathSource: "$x$", role: "heading", headingLevel: 2 });
  const chunks = nativeMarkdownDocumentChunks({
    type: "document",
    children: [{ type: "list", children: [{ type: "list_item", children: [math] }] }],
  });
  expect(chunks[0]?.kind).toBe("rich");
});

it("keeps heading size, skill labels, file icons and links in math text", () => {
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  const html = [
    nativeMathRunHtml(
      { text: "$x$", mathSource: "$x$", role: "heading", headingLevel: 2 },
      { ...textStyle, headingFontFamily: "serif" },
    ),
    nativeMathRunHtml({ text: "$deploy", skillName: "deploy", skillLabel: "Deploy" }, textStyle),
    nativeMathRunHtml(
      { text: "app.ts", href: "file:///app.ts", fileIcon: "typescript" },
      textStyle,
      { title: "app.ts", actions: [{ id: "open", title: "Open" }] },
      icon,
    ),
    nativeMathRunHtml({ text: "Email", href: "mailto:hi@example.com" }, textStyle),
    nativeMathRunHtml({ text: "Docs", href: "https://example.com" }, textStyle, {
      title: "File",
      actions: [{ id: "open", title: "Open" }],
    }),
  ].join("");
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    expect(document.querySelector<HTMLElement>(".equation")?.parentElement?.style.fontSize).toBe(
      "19px",
    );
    expect(document.querySelector<HTMLElement>(".equation")?.parentElement?.style.fontFamily).toBe(
      "serif",
    );
    expect(document.querySelector("[data-copy-source]")?.textContent).toBe("Deploy");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(icon);
    expect(document.querySelectorAll("[data-menu]")).toHaveLength(1);
    expect(document.querySelector("[data-menu]")?.getAttribute("data-href")).toBe("file:///app.ts");
    expect(document.querySelector('a[href="https://example.com"]')?.textContent).toBe("Docs");
    expect(document.querySelector('a[href="mailto:hi@example.com"]')?.textContent).toBe("Email");
  } finally {
    dom.window.close();
  }
});
