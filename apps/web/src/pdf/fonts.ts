/**
 * Font embedding utility for PDF rendering.
 *
 * Imports woff2 font files from @fontsource-variable packages and exports
 * a function returning @font-face CSS with base64 data URIs.
 *
 * Fonts included:
 * - DM Sans Variable (weight 100-900) for headings
 * - Source Serif 4 Variable (weight 200-900) for body text
 *
 * Uses latin-standard-normal woff2 variants.
 */

// Import woff2 files as inline data URLs
// Vite's ?inline suffix embeds assets as base64 data URIs
import dmSansWoff2 from "@fontsource-variable/dm-sans/files/dm-sans-latin-standard-normal.woff2?inline";
import sourceSerif4Woff2 from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-standard-normal.woff2?inline";

/**
 * Returns @font-face CSS declarations with embedded base64 font data.
 *
 * The fonts are embedded as data URIs to ensure consistent rendering
 * in sandboxed contexts (e.g., PDF rendering via data: URI).
 * System font fallbacks are included as the last src entry after the
 * base64 data URI.
 *
 * @returns CSS string containing @font-face declarations
 */
export function getFontFaces(): string {
  return `/* Embedded variable fonts for PDF rendering */
@font-face {
  font-family: 'DM Sans Variable';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(${dmSansWoff2}) format('woff2'),
       local('DM Sans'), local('Inter'), local('Roboto'), local('system-ui');
}

@font-face {
  font-family: 'Source Serif 4 Variable';
  font-style: normal;
  font-weight: 200 900;
  font-display: swap;
  src: url(${sourceSerif4Woff2}) format('woff2'),
       local('Source Serif 4'), local('Georgia'), local('Cambria'), local('Times New Roman');
}`;
}
