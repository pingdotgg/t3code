import { expect, it } from "vite-plus/test";

import { clearThemeInspectorHighlights, highlightThemeRoleUsage } from "./themeInspector";

it("counts surfaces that paint a theme color on a pseudo-element", () => {
  const stack = new DisposableStack();
  stack.defer(clearThemeInspectorHighlights);
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent =
    "#glass{width:40px;height:40px}#glass::before{content:'';position:absolute;inset:0;background:var(--app-theme-surface-raised)}";
  stack.defer(() => style.remove());
  const glass = document.body.appendChild(document.createElement("div"));
  glass.id = "glass";
  stack.defer(() => glass.remove());

  using _ = stack;
  expect(highlightThemeRoleUsage(["surfaceRaised"])).toBe(1);
});
