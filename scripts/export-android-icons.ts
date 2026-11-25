#!/usr/bin/env node

import * as NodeFSP from "node:fs/promises";
import sharp from "sharp";

const source = await NodeFSP.readFile(
  new URL("../assets/prod/app-icon.icon/Assets/mammoth.svg", import.meta.url),
  "utf8",
);
const paths = source.match(/<path[^>]*\/>/g) ?? [];
const outputDirectory = new URL("../apps/mobile/assets/", import.meta.url);

function render(name: string, size: number, artwork: string, background = "none") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 192 192"><path fill="${background}" d="M0 0h192v192H0z"/><g transform="translate(32 32)">${artwork}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toFile(new URL(name, outputDirectory).pathname);
}

const silhouette = paths[0]?.replace(/fill="[^"]*"/, 'fill="#FFF"');
if (!silhouette) throw new Error("The mammoth SVG is missing its silhouette.");

await Promise.all([
  render("android-icon-foreground.png", 432, paths.join("")),
  render("android-icon-mark.png", 432, silhouette),
  render("android-notification-icon.png", 96, silhouette),
  ...["dev", "nightly", "prod"].map((variant) =>
    render(`android-splash-icon-${variant}.png`, 1152, paths.join(""), "#E7F2FF"),
  ),
]);
