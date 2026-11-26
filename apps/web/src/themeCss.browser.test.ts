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
    @keyframes shorthand { to { border-image: var(--none, url(https://example.com/i)); } }
    [data-workspace-area="conversation"] { background: var(--theme-background-image) center / cover no-repeat; }
  `);

  const style = getComputedStyle(probe);
  expect(style.color).toBe("rgb(1, 2, 3)");
  expect(style.backgroundImage).toBe("none");
  expect(style.listStyleImage).toBe("none");
  expect(style.borderImageSource).toBe("none");
  expect(style.maskImage).toBe("none");
  const themeCssText = () =>
    document.adoptedStyleSheets
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join("\n");
  expect(themeCssText()).not.toContain("example.com");
  expect(themeCssText()).toContain(
    "background: var(--theme-background-image) center / cover no-repeat;",
  );
  expect(style.cursor).toBe("auto");

  // A later longhand hides the shorthand's text from CSSOM, and the browser still loads its url().
  applyThemeCss(`
    [data-theme-css-probe] { mask: v\\61r(--none, u\\72l(https://example.com/k)); mask-size: auto; }
    [data-theme-css-probe] { list-style: env(t3-none, url(https://example.com/l)); list-style-type: disc; }
    @keyframes hidden { to { background: var(--none, url(https://example.com/m)); background-color: red; } }
    [data-theme-css-probe] { border-image: var(--none, url(https://example.com/n)); border-image-slice: 1; }
    [data-theme-css-probe] { animation: hidden 1s forwards paused; animation-delay: -1s; }
  `);
  expect(style.maskImage).toBe("none");
  expect(style.listStyleImage).toBe("none");
  expect(style.borderImageSource).toBe("none");
  expect(style.backgroundImage).toBe("none");
  expect(style.backgroundColor).toBe("rgb(255, 0, 0)");

  // Every function that names a file is refused, in a font face and behind `all` too.
  applyThemeCss(`
    @font-face { font-family: remote; src: url(https://example.com/o.woff2); }
    [data-theme-css-probe] { background: var(--none, image-set("https://example.com/p" 1x)); background-color: red; }
    [data-theme-css-probe] { mask: var(--none, -webkit-cross-fade(url(https://example.com/q), url(https://example.com/r), 50%)); mask-size: auto; }
    [data-theme-css-probe] { all: var(--none, url(https://example.com/s)); font-size: 12px; }
    body { [data-theme-css-probe] { list-style: if(style(--none: 1): none; else: url(https://example.com/t)); list-style-type: disc; } }
  `);
  expect(themeCssText()).not.toContain("example.com");
  expect(style.backgroundImage).toBe("none");
  expect(style.maskImage).toBe("none");
  expect(style.listStyleImage).toBe("none");

  // The same shape without a fetch stays, whatever the rest of the sheet holds.
  applyThemeCss(`
    [data-theme-css-probe] {
      --edge: 4px solid red; border: var(--edge); border-left-width: 0;
      background: var(--none, linear-gradient(red, blue)); background-color: red;
    }
    .unused { c\\6flor: red; b\\61 ckground: var(--none); cursor: url(https://example.com/x), auto; }
    .unused { background: var(--none, url(https://example.com/y)); background-size: auto; }
  `);
  expect(themeCssText()).not.toContain("example.com");
  expect(style.borderTopWidth).toBe("4px");
  expect(style.borderLeftWidth).toBe("0px");
  expect(style.backgroundImage).toContain("linear-gradient");

  applyThemeCss(undefined);
  expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
});
