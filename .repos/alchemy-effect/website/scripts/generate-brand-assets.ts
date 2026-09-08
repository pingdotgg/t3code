/**
 * Build-time brand asset generator. Runs before `astro build` and emits
 * favicons + a fallback OG image into `website/public/`, all derived from
 * the single yantra geometry source in `src/brand/yantra.ts`.
 *
 * The per-page OG images are rendered separately by the static endpoint at
 * `src/pages/og/[...slug].png.ts` during `astro build`; this script only
 * produces brand artifacts that need to exist on disk before Astro starts
 * (so they're picked up by the public/ asset pipeline).
 */

import { Resvg } from "@resvg/resvg-js";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  YANTRA_THEMES,
  type YantraTheme,
  yantraSvg,
} from "../src/brand/yantra.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const fontsDir = path.resolve(here, "../assets/fonts");

/**
 * resvg does not read `@font-face`; unconfigured it resolves `font-family`
 * against the host machine's installed fonts. Point it at the TTFs
 * `scripts/download-fonts.ts` fetches into `assets/fonts/` (the `build` script
 * runs it before this one) and turn system fonts OFF, so the render is
 * identical on every machine. `defaultFontFamily` catches anything the SVG's
 * font stack fails to match.
 */
async function brandFonts() {
  const files = await readdir(fontsDir).catch(() => [] as string[]);
  const ttfs = files.filter((f) => f.endsWith(".ttf"));
  if (ttfs.length === 0) {
    throw new Error(
      `[brand] no brand fonts in ${fontsDir} — run \`bun scripts/download-fonts.ts\` first ` +
        `(the \`build\` script already does).`,
    );
  }
  return {
    fontFiles: ttfs.map((f) => path.join(fontsDir, f)),
    loadSystemFonts: false,
    defaultFontFamily: "Source Serif 4",
  };
}

type FontOptions = Awaited<ReturnType<typeof brandFonts>>;

/**
 * Render an SVG string to PNG bytes at a target square size. Pass `font` for
 * artwork containing `<text>`; the icon SVGs are pure geometry and skip it so
 * they don't pay to build a font database.
 */
function rasterize(svg: string, size: number, font?: FontOptions): Uint8Array {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0, 0, 0, 0)",
    ...(font ? { font } : {}),
  });
  return resvg.render().asPng();
}

/** Stroke weight for favicons — the 1.0 default collapses when downscaled. */
const FAVICON_STROKE = 1.4;

/**
 * Crops the yantra's built-in 2.5-unit margin so the glyph fills the favicon
 * frame — its visual extent is `r (9.5) + strokeWidth/2`, so this sits exactly
 * flush with the edge.
 */
const FAVICON_INSET = 2.5 - FAVICON_STROKE / 2;

/**
 * The favicon: the glyph alone on a transparent ground, cropped flush to the
 * edge with a bumped stroke for tab legibility. No background plate — at 16px
 * it would eat the width the strokes need.
 *
 * "light"/"dark" name the browser theme the tab sits in.
 */
function faviconMarkSvg(theme: YantraTheme): string {
  const { stroke, dot } = YANTRA_THEMES[theme];
  return yantraSvg({
    size: 64,
    strokeWidth: FAVICON_STROKE,
    inset: FAVICON_INSET,
    stroke,
    dot,
  });
}

/**
 * The vector favicon carries both themes in one file: a `prefers-color-scheme`
 * block re-paints the light mark, and CSS rules beat the presentation
 * attributes underneath. Chrome, Firefox and Safari 16.4+ re-evaluate it live
 * when the OS theme flips; anything that ignores the `<style>` (older browsers,
 * rasterizers) still renders the light mark from the attributes.
 *
 * The bindu is the only element carrying a `fill` attribute, so `circle[fill]`
 * targets it without also hitting the outer circle.
 */
function faviconVectorSvg(): string {
  const { stroke, dot } = YANTRA_THEMES.dark;
  const style = `<style>@media (prefers-color-scheme: dark){svg{stroke:${stroke}}circle[fill]{fill:${dot}}}</style>`;
  return faviconMarkSvg("light").replace(/(<svg[^>]*>)/, `$1${style}`);
}

/**
 * The mark at brand scale on a transparent ground — the single artwork behind
 * `alchemy-logo-{theme}.svg` (hotlinked by try-alchemy's auth pages and
 * alchemy-async's AuthLayout) and `icon-512{-dark}.png` (PWA / share fallback).
 *
 * Keeps the yantra's built-in margin rather than cropping flush like the
 * favicon: at this size the mark wants breathing room.
 */
function brandMarkSvg(theme: YantraTheme): string {
  const { stroke, dot } = YANTRA_THEMES[theme];
  return yantraSvg({ size: 512, stroke, dot, strokeWidth: 1.1 });
}

/** Opaque background treatment with a slightly smaller centered mark. */
function backgroundLogoSvg(theme: YantraTheme, background: string): string {
  const size = 512;
  const markSize = 448;
  const offset = (size - markSize) / 2;
  const mark = brandMarkSvg(theme).replace(
    'width="512" height="512"',
    `width="${markSize}" height="${markSize}"`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${background}"/>
    <g transform="translate(${offset} ${offset})">${mark}</g>
  </svg>`;
}

/**
 * apple-touch-icon: opaque and generously padded. The one asset that cannot be
 * transparent — iOS composites the alpha channel against black when it masks
 * the web clip into its squircle. Light only: iOS web clips have no dark
 * variant and `<link rel="apple-touch-icon">` ignores `media`.
 */
function appleTouchSvg(): string {
  const { stroke, dot, bg } = YANTRA_THEMES.light;
  // Embed the standard 24-unit yantra centered inside a 32-unit padded canvas.
  const inner = yantraSvg({ size: 24, stroke, dot, strokeWidth: 1.1 });
  // Strip the outer <svg> wrapper so we can re-mount the geometry inside a
  // padded canvas — easier than computing translate() in two places.
  const innerBody = inner.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">
    <rect width="32" height="32" fill="${bg}"/>
    <g transform="translate(4 4)" fill="none" stroke="${stroke}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${innerBody}</g>
  </svg>`;
}

/**
 * Static OG fallback (1200×630). Simple, hand-crafted SVG so this script
 * has no satori/font dependency. Used when a page has no slug-specific OG
 * image (e.g. external referrers hitting the bare domain).
 */
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_PIXEL_RATIO = 2.5;

function ogFallbackSvg(): string {
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const { stroke, bg } = YANTRA_THEMES.light;
  const glyphSize = 260;
  // Embed the exact standalone light logo rather than maintaining a second
  // OG-specific rendering of its geometry and stroke weight.
  const logo = brandMarkSvg("light").replace(
    'width="512" height="512"',
    `width="${glyphSize}" height="${glyphSize}"`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${bg}"/>
    <!-- subtle hairline frame -->
    <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="${stroke}" stroke-opacity="0.18" stroke-width="1"/>
    <!-- exact standalone logo, centered -->
    <g transform="translate(${(W - glyphSize) / 2} 48)">${logo}</g>
    <!-- wordmark -->
    <text x="${W / 2}" y="400" text-anchor="middle"
      font-family="'Source Serif 4', 'Source Serif Pro', Georgia, serif"
      font-style="italic" font-weight="500" font-size="112" fill="#2a2620"
      letter-spacing="-2">Alchemy</text>
    <text x="${W / 2}" y="462" text-anchor="middle"
      font-family="'JetBrains Mono', ui-monospace, monospace"
      font-size="18" fill="${stroke}" letter-spacing="4">
      ZERO &#8594; PRODUCTION
    </text>
    <text x="${W / 2}" y="506" text-anchor="middle"
      font-family="'Source Serif 4', 'Source Serif Pro', Georgia, serif"
      font-size="22" font-weight="600" fill="#85714f" letter-spacing="0.5">
      Infrastructure as Effects
    </text>
    <!-- bottom-right url tag -->
    <text x="${W - 48}" y="${H - 48}" text-anchor="end"
      font-family="'JetBrains Mono', ui-monospace, monospace"
      font-size="18" fill="#85714f">alchemy.run</text>
  </svg>`;
}

async function main() {
  await mkdir(publicDir, { recursive: true });

  // 1. Vector favicon — one file, both themes via prefers-color-scheme.
  await writeFile(path.join(publicDir, "favicon.svg"), faviconVectorSvg());

  // 2. Raster favicons, one pair per theme. Media queries don't survive
  //    rasterization, so each PNG comes from an explicit-color mark and the
  //    <link> tags pick between them with `media`.
  const favLight = faviconMarkSvg("light");
  const favDark = faviconMarkSvg("dark");
  for (const size of [16, 32] as const) {
    await writeFile(
      path.join(publicDir, `favicon-${size}.png`),
      rasterize(favLight, size),
    );
    await writeFile(
      path.join(publicDir, `favicon-${size}-dark.png`),
      rasterize(favDark, size),
    );
  }

  // 3. apple-touch-icon (180×180, padded, opaque).
  await writeFile(
    path.join(publicDir, "apple-touch-icon.png"),
    rasterize(appleTouchSvg(), 180),
  );

  // 4. The brand mark at 512, per theme — emitted as a transparent standalone
  //    vector, a transparent PWA/share raster, and an opaque logo raster using
  //    the theme background. None of the variants adds a frame or border.
  for (const theme of ["light", "dark"] as const) {
    const mark = brandMarkSvg(theme);
    await writeFile(path.join(publicDir, `alchemy-logo-${theme}.svg`), mark);
    await writeFile(
      path.join(publicDir, `icon-512${theme === "dark" ? "-dark" : ""}.png`),
      rasterize(mark, 512),
    );
    await writeFile(
      path.join(publicDir, `alchemy-logo-${theme}-bg.png`),
      rasterize(backgroundLogoSvg(theme, YANTRA_THEMES[theme].bg), 2048),
    );
  }

  // 5. Light brand mark on a true-white ground for consumers that cannot use
  //    the warmer theme background or composite the transparent asset.
  await writeFile(
    path.join(publicDir, "alchemy-logo-512-white-bg.png"),
    rasterize(backgroundLogoSvg("light", "#ffffff"), 2048),
  );

  // 6. Backwards-compat: keep the old /favicon.png reference (used by
  //    some cached nav code) pointing to the 32px raster.
  await writeFile(path.join(publicDir, "favicon.png"), rasterize(favLight, 32));

  // 7. OG fallback (1200×630). Per-page OG images come from the static
  //    endpoint; this is the bare-domain fallback, and the only asset with
  //    text, so the only one needing the brand font database.
  const ogSvg = ogFallbackSvg();
  await writeFile(path.join(publicDir, "og-default.svg"), ogSvg);
  await writeFile(
    path.join(publicDir, "og-default.png"),
    rasterize(ogSvg, OG_WIDTH * OG_PIXEL_RATIO, await brandFonts()),
  );

  // eslint-disable-next-line no-console
  console.log(
    "[brand] wrote favicon.{svg,png}, favicon-{16,32}[-dark].png, apple-touch-icon.png, icon-512[-dark].png, alchemy-logo-{light,dark}.svg, alchemy-logo-{light,dark}-bg.png (2048px), alchemy-logo-512-white-bg.png (2048px), og-default.{svg,png}",
  );
}

await main();
