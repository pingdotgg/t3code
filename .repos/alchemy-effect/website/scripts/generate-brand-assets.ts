/**
 * Build-time brand asset generator. Runs before `astro build` and emits
 * favicons + a fallback OG image into `website/public/`, all derived from
 * the single yantra geometry source in `src/brand/yantra.ts`.
 *
 * The per-page OG images are rendered separately by the static endpoint at
 * `src/pages/og/[...slug].webp.ts` during `astro build`; this script only
 * produces brand artifacts that need to exist on disk before Astro starts
 * (so they're picked up by the public/ asset pipeline).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, renderSvg } from "takumi-js";
import { brandFonts } from "../src/brand/fonts.ts";
import {
  OG_DEFAULT_H,
  OG_DEFAULT_W,
  OgDefault,
} from "../src/brand/OgDefault.tsx";
import {
  YANTRA_THEMES,
  type YantraTheme,
  yantraSvg,
} from "../src/brand/yantra.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
/** Rasterize the geometric icon artwork with Takumi. */
function rasterize(svg: string, size: number): Promise<Uint8Array> {
  return render(
    {
      type: "image",
      src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      style: { width: size, height: size },
    },
    { width: size, height: size, format: "png" },
  );
}

/** Favicons use exactly the same geometry and margins as the logo SVG. */
function faviconMarkSvg(theme: YantraTheme): string {
  return yantraSvg({ size: 64, theme });
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

/** Canonical standalone logo, also used by app icons and the OG fallback. */
function brandMarkSvg(theme: YantraTheme): string {
  return yantraSvg({ size: 512, theme });
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
  const { bg } = YANTRA_THEMES.light;
  const inner = yantraSvg();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">
    <rect width="32" height="32" fill="${bg}"/>
    <g transform="translate(4 4)">${inner}</g>
  </svg>`;
}

const OG_PIXEL_RATIO = 2.5;

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
      await rasterize(favLight, size),
    );
    await writeFile(
      path.join(publicDir, `favicon-${size}-dark.png`),
      await rasterize(favDark, size),
    );
  }

  // 3. apple-touch-icon (180×180, padded, opaque).
  await writeFile(
    path.join(publicDir, "apple-touch-icon.png"),
    await rasterize(appleTouchSvg(), 180),
  );

  // 4. The brand mark at 512, per theme — emitted as a transparent standalone
  //    vector, a transparent PWA/share raster, and an opaque logo raster using
  //    the theme background. None of the variants adds a frame or border.
  for (const theme of ["light", "dark"] as const) {
    const mark = brandMarkSvg(theme);
    await writeFile(path.join(publicDir, `alchemy-logo-${theme}.svg`), mark);
    await writeFile(
      path.join(publicDir, `icon-512${theme === "dark" ? "-dark" : ""}.png`),
      await rasterize(mark, 512),
    );
    await writeFile(
      path.join(publicDir, `alchemy-logo-${theme}-bg.png`),
      await rasterize(backgroundLogoSvg(theme, YANTRA_THEMES[theme].bg), 2048),
    );
  }

  // 5. Light brand mark on a true-white ground for consumers that cannot use
  //    the warmer theme background or composite the transparent asset.
  await writeFile(
    path.join(publicDir, "alchemy-logo-512-white-bg.png"),
    await rasterize(backgroundLogoSvg("light", "#ffffff"), 2048),
  );

  // 6. Backwards-compat: keep the old /favicon.png reference (used by
  //    some cached nav code) pointing to the 32px raster.
  await writeFile(
    path.join(publicDir, "favicon.png"),
    await rasterize(favLight, 32),
  );

  // 7. Fallback OG: Takumi emits both PNG and outlined SVG from one layout.
  const card = OgDefault();
  const options = {
    width: OG_DEFAULT_W,
    height: OG_DEFAULT_H,
    fonts: await brandFonts,
    emoji: "from-font" as const,
  };
  await writeFile(
    path.join(publicDir, "og-default.svg"),
    await renderSvg(card, options),
  );
  await writeFile(
    path.join(publicDir, "og-default.png"),
    await render(card, {
      ...options,
      format: "png",
      width: OG_DEFAULT_W * OG_PIXEL_RATIO,
      height: OG_DEFAULT_H * OG_PIXEL_RATIO,
      devicePixelRatio: OG_PIXEL_RATIO,
    }),
  );

  // eslint-disable-next-line no-console
  console.log(
    "[brand] wrote favicon.{svg,png}, favicon-{16,32}[-dark].png, apple-touch-icon.png, icon-512[-dark].png, alchemy-logo-{light,dark}.svg, alchemy-logo-{light,dark}-bg.png (2048px), alchemy-logo-512-white-bg.png (2048px), og-default.{svg,png}",
  );
}

await main();
