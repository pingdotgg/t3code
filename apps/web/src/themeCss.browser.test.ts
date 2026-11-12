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
    :root { --leak: u\\72l(https://example.com/a); }
    [data-theme-css-probe] {
      color: rgb(1, 2, 3);
      background-image: u\\72l(https://example.com/b);
      list-style-image: var(--leak);
      @media (min-width: 0px) { cursor: url(https://example.com/c), auto; }
    }
  `);

  const style = getComputedStyle(probe);
  expect(style.color).toBe("rgb(1, 2, 3)");
  expect(style.backgroundImage).toBe("none");
  expect(style.listStyleImage).toBe("none");
  expect(style.cursor).toBe("auto");

  applyThemeCss(undefined);
  expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
});
