import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceFontVariables, startAppearanceFontSync } from "./appearanceFonts";

function renderedFontSize(style: (probe: HTMLElement) => void): string {
  const probe = document.createElement("div");
  style(probe);
  document.body.append(probe);
  try {
    return getComputedStyle(probe).fontSize;
  } finally {
    probe.remove();
  }
}

const composerFontSize = () =>
  renderedFontSize((probe) => {
    // The composer editor's own size class.
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  });

const touchComposerFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  });

describe("applyAppearanceFontVariables", () => {
  it("sizes the composer from the interface size until fonts are set separately", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const typography = root.dataset.typography;
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      reply: "",
      sizeInterface: 20,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
    };
    try {
      applyAppearanceFontVariables(root, { ...preferences, separate: false });
      expect(composerFontSize()).toBe("17.5px");
      expect(touchComposerFontSize()).toBe("17.5px");

      applyAppearanceFontVariables(root, {
        ...preferences,
        typography: "absolutely",
        separate: false,
      });
      expect(composerFontSize()).toBe("18.75px");
      expect(touchComposerFontSize()).toBe("18.75px");

      applyAppearanceFontVariables(root, {
        ...preferences,
        typography: "absolutely",
        separate: true,
      });
      expect(composerFontSize()).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
      if (typography === undefined) delete root.dataset.typography;
      else root.dataset.typography = typography;
    }
  });

  it("refreshes the current reply gutter when a font finishes loading", async () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const typography = root.dataset.typography;
    const face = new FontFace(
      "Deferred Reply",
      `url(${new URL("../../../packages/shared/assets/fonts/jetbrains-mono/web/jetbrains-mono-latin-wght-normal.woff2", import.meta.url).href})`,
    );
    const markdown = document.createElement("div");
    markdown.className = "chat-markdown font-reply";
    markdown.style.fontSize = "14px";
    const list = document.createElement("ol");
    markdown.append(list);
    document.body.append(markdown);
    using fonts = startAppearanceFontSync(root);
    const preferences = {
      sans: "sans-serif",
      code: "",
      composer: "",
      reply: "Deferred Reply",
      sizeInterface: 16,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
      separate: false,
    };
    const gutter = () => Number.parseFloat(getComputedStyle(list).paddingInlineStart);
    try {
      fonts.apply({ ...preferences, reply: "monospace", typography: "absolutely" });
      fonts.apply(preferences);
      expect(gutter()).toBe(20);

      document.fonts.add(face);
      await document.fonts.load('16px "Deferred Reply"');
      await document.fonts.ready;
      expect(gutter()).toBeGreaterThan(24);

      fonts.apply({ ...preferences, reply: "" });
      document.fonts.dispatchEvent(new Event("loadingdone"));
      expect(gutter()).toBe(20);
      expect(root.dataset.typography).toBeUndefined();
    } finally {
      document.fonts.delete(face);
      markdown.remove();
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
      if (typography === undefined) delete root.dataset.typography;
      else root.dataset.typography = typography;
    }
  });

  it("widens the numbered-list gutter only when the interface font's marker would clip", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const gutter = (sans: string, reply = "", assistant = false) => {
      applyAppearanceFontVariables(root, {
        sans,
        reply,
        code: "",
        composer: "",
        sizeInterface: 16,
        sizePrompt: 14,
        sizeCode: 13,
        smoothing: true,
        separate: false,
      });
      const markdown = document.createElement("div");
      markdown.className = assistant ? "chat-markdown font-reply" : "chat-markdown";
      markdown.style.fontSize = "14px";
      const list = document.createElement("ol");
      markdown.append(list);
      document.body.append(markdown);
      try {
        return Number.parseFloat(getComputedStyle(list).paddingInlineStart);
      } finally {
        markdown.remove();
      }
    };
    try {
      // `0. ` in a 14px monospace font is about 25px, past the 20px default.
      expect(gutter("monospace")).toBeGreaterThan(24);
      expect(gutter("sans-serif")).toBe(20);
      expect(gutter("sans-serif", "monospace", true)).toBeGreaterThan(24);
      expect(gutter("monospace", "sans-serif", true)).toBe(20);
      expect(gutter("sans-serif", "monospace")).toBe(20);
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
