import { expect, it } from "vite-plus/test";

import { applyThemeCss } from "./themeCss";

it("applies theme CSS and drops every rule that would load a remote file", () => {
  const probe = document.createElement("div");
  probe.dataset.themeCssProbe = "";
  document.body.append(probe);
  using _probe = { [Symbol.dispose]: () => probe.remove() };
  using _css = { [Symbol.dispose]: () => applyThemeCss(undefined) };

  applyThemeCss(`
    @import url(https://example.com/sheet.css);
    @namespace svg url(http://www.w3.org/2000/svg);
    @property --registered { syntax: "<url>"; inherits: false; initial-value: url(https://example.com/d); }
    @counter-style leak { system: cyclic; symbols: url(https://example.com/f); }
    @keyframes leak { to { background-image: url(https://example.com/g); } }
    :root { --leak: u\\72l(https://example.com/a); }
    [data-theme-css-probe] {
      color: rgb(1, 2, 3);
      background-image: u\\72l(https://example.com/b);
      list-style-image: var(--leak);
      border-image-source: var(--registered);
      mask-image: v\\61r(--none, u\\72l(https://example.com/e));
      @media (min-width: 0px) { cursor: url(https://example.com/c), auto; }
    }
  `);

  const style = getComputedStyle(probe);
  expect(style.color).toBe("rgb(1, 2, 3)");
  expect(style.backgroundImage).toBe("none");
  expect(style.listStyleImage).toBe("none");
  expect(style.borderImageSource).toBe("none");
  expect(style.maskImage).toBe("none");
  const kept = document.adoptedStyleSheets.flatMap((sheet) =>
    Array.from(sheet.cssRules, (rule) => rule.cssText),
  );
  expect(kept.join("\n")).not.toContain("example.com");
  expect(style.cursor).toBe("auto");

  applyThemeCss(undefined);
  expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
});
