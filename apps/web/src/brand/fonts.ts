import { roundHogFontFaceCss } from "@posthog/brand/fonts/css";

export const ROUND_HOG_FONT_FAMILY = "RoundHog";

const STYLE_ELEMENT_ID = "posthog-roundhog-font-faces";

/**
 * Registers RoundHog's eight faces once per document. The woff2 files ship
 * inside `@posthog/brand`, so the rules carry bundler-resolved URLs rather
 * than a network font host; call this before React mounts so interface text
 * never paints in the fallback stack.
 */
export function installBrandFonts(doc: Document = document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = roundHogFontFaceCss;
  doc.head.append(style);
}
