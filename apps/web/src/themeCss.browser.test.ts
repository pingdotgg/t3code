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
    [data-theme-css-probe] { background: var(--none, url(https://example.com/h)); }
    [data-theme-css-probe] { mask: var(--none, url(https://example.com/k)); mask-size: auto; }
    [data-workspace-area="conversation"] { --toggle: ; background: var(--theme-background-image) center / cover no-repeat; }
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
  expect(kept.join("\n")).toContain(
    "background: var(--theme-background-image) center / cover no-repeat;",
  );
  expect(kept.join("\n")).toContain("--toggle:");
  expect(style.cursor).toBe("auto");

  // Overriding one longhand hides a var() shorthand's text; a fetch in another rule must not drop it.
  applyThemeCss(`
    [data-theme-css-probe] {
      --edge: 4px solid red; border: var(--edge); border-left-width: 0px;
      background: var(--none, linear-gradient(red, blue)); background-color: red;
    }
    .unused { cursor: url(https://example.com/x), auto; }
  `);
  expect(style.borderTopWidth).toBe("4px");
  expect(style.backgroundImage).toContain("linear-gradient");

  applyThemeCss(`
    [data-theme-css-probe] { list-style: env(t3-none, url(https://example.com/l)); list-style-type: disc; }
  `);
  expect(style.listStyleImage).toBe("none");

  applyThemeCss(undefined);
  expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
});
