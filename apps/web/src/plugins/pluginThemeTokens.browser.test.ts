import { THEME_TOKENS } from "@t3tools/plugin-sdk/web";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

// A plugin's `var(--border)` resolves to nothing, and its component draws unstyled, once T3's
// stylesheet stops defining the token.
describe("the theme tokens the plugin SDK promises", () => {
  it("are defined by T3's stylesheet in light and dark", () => {
    const root = document.documentElement;
    try {
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        const style = getComputedStyle(root);
        for (const token of THEME_TOKENS) {
          expect(style.getPropertyValue(token).trim(), `${token} in ${appearance}`).not.toBe("");
        }
      }
    } finally {
      root.classList.remove("dark");
    }
  });
});
