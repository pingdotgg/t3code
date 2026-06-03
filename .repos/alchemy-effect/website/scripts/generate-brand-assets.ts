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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { YANTRA_COLORS, yantraSvg } from "../src/brand/yantra.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");

/** Render an SVG string to PNG bytes at a target square size. */
function rasterize(svg: string, size: number): Uint8Array {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0, 0, 0, 0)",
  });
  return resvg.render().asPng();
}

/**
 * A favicon-friendly variant of the yantra: parchment tile with a small
 * inner padding so the glyph reads well at 16px. The stroke weight is bumped
 * because the lines collapse below ~1.4 viewBox units when downscaled.
 */
function faviconTileSvg(): string {
  return yantraSvg({
    size: 64,
    bg: YANTRA_COLORS.bg,
    stroke: YANTRA_COLORS.stroke,
    dot: YANTRA_COLORS.dot,
    strokeWidth: 1.4,
  });
}

/**
 * apple-touch-icon needs an opaque background and generous padding —
 * iOS renders it inside its own rounded-rect mask.
 */
function appleTouchSvg(): string {
  // Embed the standard 24-unit yantra centered inside a 32-unit padded canvas.
  const inner = yantraSvg({
    size: 24,
    stroke: YANTRA_COLORS.stroke,
    dot: YANTRA_COLORS.dot,
    strokeWidth: 1.1,
  });
  // Strip the outer <svg> wrapper so we can re-mount the geometry inside a
  // padded canvas — easier than computing translate() in two places.
  const innerBody = inner.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">
    <rect width="32" height="32" fill="${YANTRA_COLORS.bg}"/>
    <g transform="translate(4 4)" fill="none" stroke="${YANTRA_COLORS.stroke}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${innerBody}</g>
  </svg>`;
}

/**
 * Static OG fallback (1200×630). Simple, hand-crafted SVG so this script
 * has no satori/font dependency. Used when a page has no slug-specific OG
 * image (e.g. external referrers hitting the bare domain).
 */
function ogFallbackSvg(): string {
  const W = 1200;
  const H = 630;
  // Yantra glyph centered, large.
  const glyphSize = 220;
  const glyph = yantraSvg({
    size: glyphSize,
    stroke: YANTRA_COLORS.stroke,
    dot: YANTRA_COLORS.dot,
    strokeWidth: 0.7,
  })
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${YANTRA_COLORS.bg}"/>
    <!-- subtle hairline frame -->
    <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="${YANTRA_COLORS.stroke}" stroke-opacity="0.18" stroke-width="1"/>
    <!-- yantra centered, slightly above midline so wordmark sits below -->
    <g transform="translate(${(W - glyphSize) / 2} ${H / 2 - glyphSize - 20})" viewBox="0 0 24 24">
      <svg width="${glyphSize}" height="${glyphSize}" viewBox="0 0 24 24" fill="none" stroke="${YANTRA_COLORS.stroke}" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>
    </g>
    <!-- wordmark -->
    <text x="${W / 2}" y="${H / 2 + 60}" text-anchor="middle"
      font-family="'Source Serif 4', 'Source Serif Pro', Georgia, serif"
      font-style="italic" font-weight="500" font-size="96" fill="#2a2620"
      letter-spacing="-2">alchemy</text>
    <text x="${W / 2}" y="${H / 2 + 120}" text-anchor="middle"
      font-family="'JetBrains Mono', ui-monospace, monospace"
      font-size="20" fill="${YANTRA_COLORS.stroke}" letter-spacing="4">
      ZERO &#8594; PRODUCTION
    </text>
    <!-- bottom-right url tag -->
    <text x="${W - 48}" y="${H - 48}" text-anchor="end"
      font-family="'JetBrains Mono', ui-monospace, monospace"
      font-size="18" fill="#85714f">alchemy.run</text>
  </svg>`;
}

async function main() {
  await mkdir(publicDir, { recursive: true });

  // 1. Vector favicon — parchment tile, bumped stroke for tab legibility.
  const favSvg = faviconTileSvg();
  await writeFile(path.join(publicDir, "favicon.svg"), favSvg);

  // 2. Raster favicons.
  await writeFile(
    path.join(publicDir, "favicon-32.png"),
    rasterize(favSvg, 32),
  );
  await writeFile(
    path.join(publicDir, "favicon-16.png"),
    rasterize(favSvg, 16),
  );

  // 3. apple-touch-icon (180×180, padded, opaque parchment).
  const apple = appleTouchSvg();
  await writeFile(
    path.join(publicDir, "apple-touch-icon.png"),
    rasterize(apple, 180),
  );

  // 4. Larger PWA / share fallback at 512×512.
  await writeFile(path.join(publicDir, "icon-512.png"), rasterize(apple, 512));

  // 5. Backwards-compat: keep the old /favicon.png reference (used by
  //    some cached nav code) pointing to the 32px raster.
  await writeFile(path.join(publicDir, "favicon.png"), rasterize(favSvg, 32));

  // 6. OG fallback (1200×630). Per-page OG images come from the static
  //    endpoint; this is the bare-domain fallback.
  const ogSvg = ogFallbackSvg();
  await writeFile(path.join(publicDir, "og-default.svg"), ogSvg);
  await writeFile(
    path.join(publicDir, "og-default.png"),
    rasterize(ogSvg, 1200),
  );

  // eslint-disable-next-line no-console
  console.log(
    "[brand] wrote favicon.{svg,png}, favicon-{16,32}.png, apple-touch-icon.png, icon-512.png, og-default.{svg,png}",
  );
}

await main();
