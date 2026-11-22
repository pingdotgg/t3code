#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-off asset generator run by hand.
// Conn: renders the Android icon layers from the Conn Icon Composer projects into assets/conn/android,
// with the same canvases as upstream's scripts/export-android-icons.ts (432px adaptive layers, 96px
// notification icon, 1152px splash). Run: `node scripts/export-conn-android-icons.ts`. Commit the output.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import sharp from "sharp";

const here = NodePath.resolve(import.meta.dirname, "../assets/conn");
const out = NodePath.join(here, "android");
const ADAPTIVE = 432;
const SPLASH = 1152;
const NOTIFICATION = 96;
// Share of the canvas the mark spans; Android masks a 72dp safe area inside 108dp.
const MARK_FRACTION = 0.42;

const layer = (variant: "dev" | "prod", file: string) =>
  NodeFS.readFileSync(NodePath.join(here, variant, "app-icon.icon", "Assets", file), "utf8");

// The Conn mark's paths in its own 440x440 space, from the production text layer.
const markPaths = (layer("prod", "text.svg").match(/<path[^>]*\/>/g) ?? []).join("");

const markSvg = (size: number, fraction: number, fill: string) => {
  const scale = (size * fraction) / 440;
  const offset = (size - 440 * scale) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g transform="translate(${offset} ${offset}) scale(${scale})" fill="${fill}">${markPaths}</g></svg>`,
  );
};

const raster = (svg: Buffer | string, size: number) =>
  sharp(Buffer.isBuffer(svg) ? svg : Buffer.from(svg), { density: 300 })
    .resize(size, size)
    .png()
    .toBuffer();

// The dev background is the blueprint layer, stretched to full bleed (Android applies its own mask).
const fullBleed = (svg: string) =>
  svg.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, "");
    return `<svg${cleaned} width="1024" height="1024" preserveAspectRatio="xMidYMid slice">`;
  });

async function main() {
  NodeFS.mkdirSync(out, { recursive: true });
  const foreground = await raster(markSvg(ADAPTIVE, MARK_FRACTION, "white"), ADAPTIVE);
  const monochrome = await raster(markSvg(ADAPTIVE, MARK_FRACTION, "white"), ADAPTIVE);
  const notification = await raster(markSvg(NOTIFICATION, 0.75, "white"), NOTIFICATION);
  const devBackground = await raster(fullBleed(layer("dev", "background.svg")), ADAPTIVE);
  const splashMark = await raster(markSvg(SPLASH, MARK_FRACTION, "white"), SPLASH);
  const devSplashBg = await raster(fullBleed(layer("dev", "background.svg")), SPLASH);
  const devSplash = await sharp(devSplashBg)
    .composite([{ input: splashMark }])
    .png()
    .toBuffer();
  const prodSplash = await sharp({
    create: { width: SPLASH, height: SPLASH, channels: 4, background: "#000000" },
  })
    .composite([{ input: splashMark }])
    .png()
    .toBuffer();
  const files: ReadonlyArray<readonly [string, Buffer]> = [
    ["android-icon-foreground.png", foreground],
    ["android-icon-mark.png", monochrome],
    ["android-notification-icon.png", notification],
    ["android-icon-background-dev.png", devBackground],
    ["android-splash-icon-dev.png", devSplash],
    ["android-splash-icon-prod.png", prodSplash],
  ];
  for (const [name, contents] of files) {
    NodeFS.writeFileSync(NodePath.join(out, name), contents);
    console.log(`wrote assets/conn/android/${name}`);
  }
}

await main();
