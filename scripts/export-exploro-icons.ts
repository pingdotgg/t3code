// @effect-diagnostics nodeBuiltinImport:off - Uses Node built-in fs and path for icon rendering.
// Renders Exploro's app icons from the SVG sources in assets/brand with sharp, so icons can be
// regenerated on any OS. It writes the same files the Icon Composer export (icons:export) owns.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const fromRoot = (relativePath: string) => NodePath.join(repoRoot, relativePath);

// The classic macOS safe area: an 824px body inset 100px on a 1024px canvas.
const MAC_CANVAS = 1024;
const MAC_BODY = 824;

const VARIANTS = [
  {
    source: "assets/brand/mark.svg",
    outputs: {
      full: [BRAND_ASSET_PATHS.productionIosIconPng, BRAND_ASSET_PATHS.productionLinuxIconPng],
      mac: BRAND_ASSET_PATHS.productionMacIconPng,
      ico: [BRAND_ASSET_PATHS.productionWindowsIconIco, BRAND_ASSET_PATHS.productionWebFaviconIco],
      png: {
        16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        180: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        192: BRAND_ASSET_PATHS.productionWebIcon192Png,
        512: BRAND_ASSET_PATHS.productionWebIcon512Png,
      },
    },
  },
  {
    source: "assets/brand/mark-dark.svg",
    outputs: {
      full: [BRAND_ASSET_PATHS.nightlyIosIconPng, BRAND_ASSET_PATHS.nightlyLinuxIconPng],
      mac: BRAND_ASSET_PATHS.nightlyMacIconPng,
      ico: [BRAND_ASSET_PATHS.nightlyWindowsIconIco, BRAND_ASSET_PATHS.nightlyWebFaviconIco],
      png: {
        16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
        32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
        180: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
        192: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
        512: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
      },
    },
  },
  {
    source: "assets/brand/mark-dark.svg",
    outputs: {
      full: [
        BRAND_ASSET_PATHS.developmentIosIconPng,
        BRAND_ASSET_PATHS.developmentUniversalIconPng,
      ],
      mac: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      ico: [
        BRAND_ASSET_PATHS.developmentWindowsIconIco,
        BRAND_ASSET_PATHS.developmentWebFaviconIco,
      ],
      png: {
        16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        180: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
        192: BRAND_ASSET_PATHS.developmentWebIcon192Png,
        512: BRAND_ASSET_PATHS.developmentWebIcon512Png,
      },
    },
  },
] as const;

async function render(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg, { density: Math.max(72, (72 * size) / 128) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

for (const variant of VARIANTS) {
  const svg = await NodeFSP.readFile(fromRoot(variant.source));
  const full = await render(svg, 1024);
  for (const target of variant.outputs.full) await NodeFSP.writeFile(fromRoot(target), full);

  const inset = (MAC_CANVAS - MAC_BODY) / 2;
  const mac = await sharp(await render(svg, MAC_BODY))
    .extend({ top: inset, bottom: inset, left: inset, right: inset, background: "#0000" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await NodeFSP.writeFile(fromRoot(variant.outputs.mac), mac);

  for (const [size, target] of Object.entries(variant.outputs.png)) {
    await NodeFSP.writeFile(fromRoot(target), await render(svg, Number(size)));
  }

  const ico = encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await render(svg, size) })),
    ),
  );
  for (const target of variant.outputs.ico) await NodeFSP.writeFile(fromRoot(target), ico);
}

for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
  await NodeFSP.copyFile(
    fromRoot(override.sourceRelativePath),
    fromRoot(override.targetRelativePath),
  );
}
