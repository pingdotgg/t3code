import type { IconNode } from "./connIcon";

/** SVG attribute name for a glyph attribute (glyphs use React's camelCase names). */
export function glyphAttributeName(key: string): string {
  return key === "fillRule" ? "fill-rule" : key === "clipRule" ? "clip-rule" : key;
}

/** A glyph's elements as an SVG string (viewBox 0 0 16 16, filled with the current color). */
export function glyphChildrenMarkup(glyph: IconNode): string {
  return glyph
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([key, value]) => `${glyphAttributeName(key)}="${value}"`)
          .join(" ")}/>`,
    )
    .join("");
}

/** A glyph as an SVG string, for markup built outside React. `attributes` go on the root. */
export function glyphSvgMarkup(glyph: IconNode, attributes = ""): string {
  const children = glyphChildrenMarkup(glyph);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" ${attributes}>${children}</svg>`;
}
