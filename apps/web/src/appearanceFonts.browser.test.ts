import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceFontVariables, hasAllLatinLetters } from "./appearanceFonts";
import interFontUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import symbolsFontUrl from "./terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2?url";

// A face with no Latin glyphs and, by default, a deep descent.
async function loadLopsidedSymbolsFont(
  family: string,
  metrics = { ascentOverride: "50%", descentOverride: "90%" },
): Promise<FontFace> {
  const data = await fetch(symbolsFontUrl).then((response) => response.arrayBuffer());
  const face = new FontFace(family, data, metrics);
  document.fonts.add(await face.load());
  return face;
}

const interfacePreferences = {
  code: "",
  composer: "",
  sizeInterface: 16,
  sizePrompt: 14,
  sizeCode: 13,
  smoothing: true,
  separate: false,
};

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
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      sizeInterface: 20,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
    };
    try {
      applyAppearanceFontVariables(root, { ...preferences, separate: false });
      expect(composerFontSize()).toBe("17.5px");
      expect(touchComposerFontSize()).toBe("17.5px");

      applyAppearanceFontVariables(root, { ...preferences, separate: true });
      expect(composerFontSize()).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("widens the numbered-list gutter only when the interface font's marker would clip", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const gutter = (sans: string) => {
      applyAppearanceFontVariables(root, {
        sans,
        code: "",
        composer: "",
        sizeInterface: 16,
        sizePrompt: 14,
        sizeCode: 13,
        smoothing: true,
        separate: false,
      });
      const markdown = document.createElement("div");
      markdown.className = "chat-markdown";
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
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("centers capitals in a control when the interface font's ascent and descent are unbalanced", async () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const face = await loadLopsidedSymbolsFont("Lopsided Symbols");
    const control = document.createElement("div");
    control.style.cssText =
      "display:flex;align-items:center;height:40px;font-family:var(--font-sans);font-size:20px;line-height:20px";
    control.innerHTML =
      '<span>H<i style="display:inline-block;width:0;height:0"></i></span><b style="height:1cap"></b><b style="height:1ex"></b>';
    try {
      applyAppearanceFontVariables(root, { ...interfacePreferences, sans: "Lopsided Symbols" });
      await document.fonts.ready;
      document.body.append(control);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `20px ${getComputedStyle(control).fontFamily}`;
      const capHeight = context.measureText("H").actualBoundingBoxAscent;
      const baseline = control.querySelector("i")!.getBoundingClientRect().top;
      const box = control.getBoundingClientRect();
      expect(Math.abs(baseline - capHeight / 2 - (box.top + box.height / 2))).toBeLessThan(0.5);
      // `cap` units and `text-box: trim-both cap` read the first font's cap height.
      const [capUnit, exUnit] = [...control.querySelectorAll("b")].map(
        (unit) => unit.getBoundingClientRect().height,
      );
      expect(Math.abs(capUnit! - capHeight)).toBeLessThan(0.5);
      const xHeight = context.measureText("x").actualBoundingBoxAscent;
      expect(Math.abs(exUnit! - xHeight)).toBeLessThan(0.5);

      // A font that already centers its capitals keeps the plain stack.
      const balanced = await loadLopsidedSymbolsFont("Balanced Symbols", {
        ascentOverride: "86%",
        descentOverride: "14%",
      });
      try {
        applyAppearanceFontVariables(root, { ...interfacePreferences, sans: "Balanced Symbols" });
        expect(root.style.getPropertyValue("--font-sans")).toMatch(/^"Balanced Symbols", /);
      } finally {
        document.fonts.delete(balanced);
      }
    } finally {
      control.remove();
      applyAppearanceFontVariables(root, { ...interfacePreferences, sans: "" });
      document.fonts.delete(face);
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});

describe("hasAllLatinLetters", () => {
  it("rejects a face whose Latin letters fall back to another font", async () => {
    // Inter cut down to digits and periods draws punctuation but no letters, like Al Tarikh.
    const faces = [
      new FontFace("Digits Only", `url(${interFontUrl})`, { unicodeRange: "U+2E, U+30-39" }),
      new FontFace("Percent Only", `url(${interFontUrl})`, { unicodeRange: "U+25" }),
      new FontFace("Space Only", `url(${interFontUrl})`, { unicodeRange: "U+20" }),
      new FontFace("Missing A", `url(${interFontUrl})`, { unicodeRange: "U+20-40, U+42-7E" }),
      new FontFace("Full Inter", `url(${interFontUrl})`),
    ];
    for (const face of faces) document.fonts.add(await face.load());
    try {
      expect(hasAllLatinLetters("Digits Only")).toBe(false);
      expect(hasAllLatinLetters("Digits Only, sans-serif")).toBe(false);
      expect(hasAllLatinLetters("Not An Installed Font, Digits Only")).toBe(false);
      expect(hasAllLatinLetters("Percent Only, sans-serif")).toBe(false);
      expect(hasAllLatinLetters("Space Only, sans-serif")).toBe(false);
      expect(hasAllLatinLetters("Missing A")).toBe(false);
      expect(hasAllLatinLetters("Full Inter")).toBe(true);
      expect(hasAllLatinLetters("Not An Installed Font, Full Inter")).toBe(true);
      expect(hasAllLatinLetters("Not An Installed Font")).toBe(false);
      expect(hasAllLatinLetters("Not An Installed Font, sans-serif")).toBe(true);
      expect(hasAllLatinLetters("sans-serif")).toBe(true);
      expect(hasAllLatinLetters("ui-monospace")).toBe(true);
    } finally {
      for (const face of faces) document.fonts.delete(face);
    }
  });
});
