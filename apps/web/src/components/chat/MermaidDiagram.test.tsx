// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { sanitizeMermaidSvg } from "./MermaidDiagram";

// The label markup Mermaid's sequence diagrams emit for $$...$$ text.
function noteSvg(label: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><foreignObject height="34" width="35" x="57" y="85"><div style="width: fit-content;" xmlns="http://www.w3.org/1999/xhtml"><div style="display: flex; align-items: center; justify-content: center; white-space: nowrap;"><span class="katex">${label}</span></div></div></foreignObject></svg>`;
}

function sanitize(svg: string) {
  const host = document.createElement("div");
  host.innerHTML = sanitizeMermaidSvg(svg);
  return host;
}

describe("sanitizeMermaidSvg", () => {
  it("keeps the MathML Mermaid renders for math labels", () => {
    const host = sanitize(
      noteSvg(
        '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>x</mi></mrow></mfrac><mrow><mo fence="true">(</mo><mi mathvariant="bold">v</mi><mo fence="true">)</mo></mrow><msqrt><mn>2</mn></msqrt></mrow></math>',
      ),
    );

    const math = host.querySelector(".katex > math");
    expect(math?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math?.getAttribute("display")).toBe("block");
    expect(math?.querySelector("mfrac")?.textContent).toBe("ddx");
    expect(math?.querySelector("msqrt")?.textContent).toBe("2");
    expect(math?.querySelector("mi[mathvariant='bold']")?.textContent).toBe("v");
    expect(math?.querySelectorAll("mo[fence='true']")).toHaveLength(2);
  });

  it("keeps spaced math labels parseable as an SVG image", () => {
    // KaTeX renders \text{total cost} with a no-break space.
    const svg = sanitizeMermaidSvg(noteSvg("<math><mrow><mtext>total cost</mtext></mrow></math>"));

    const image = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(image.documentElement.localName).toBe("svg");
    expect(image.querySelector("mtext")?.textContent).toBe("total cost");
  });

  it("strips links, scripts, and MathML outside what KaTeX emits", () => {
    const host = sanitize(
      noteSvg(
        '<math href="javascript:alert(1)"><mi href="javascript:alert(1)" onclick="alert(1)">x</mi><maction actiontype="toggle"><mi>a</mi></maction><mglyph src="https://example.com/a.png"></mglyph><annotation-xml encoding="text/html"><img src="x" onerror="alert(1)"></annotation-xml><semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation></semantics></math>',
      ),
    );

    const math = host.querySelector("math");
    expect(math).not.toBeNull();
    expect(math?.querySelector("mi")?.textContent).toBe("x");
    expect(host.querySelector("[href], [onclick], [src], [onerror]")).toBeNull();
    expect(host.querySelector("maction, mglyph, annotation-xml, annotation, semantics, img")).toBe(
      null,
    );
  });

  it("only accepts math as an HTML label and keeps its attributes on MathML", () => {
    const host = sanitize(
      '<svg xmlns="http://www.w3.org/2000/svg"><math><mi>x</mi></math><text mathvariant="bold" fence="true">label</text></svg>',
    );

    expect(host.querySelector("math, mi")).toBeNull();
    expect(host.querySelector("text")?.getAttributeNames()).toEqual([]);
  });
});
