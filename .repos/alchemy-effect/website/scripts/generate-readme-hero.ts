import { mkdir, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import { render } from "takumi-js";
import {
  README_HERO_H,
  README_HERO_W,
  ReadmeHero,
} from "../src/brand/ReadmeHero.tsx";
import { brandFonts } from "../src/brand/fonts.ts";

const webp = await render(ReadmeHero(), {
  devicePixelRatio: 2,
  width: README_HERO_W * 2,
  height: README_HERO_H * 2,
  format: "webp",
  fonts: brandFonts,
});

const repoRoot = join(import.meta.dirname, "../..");
const outFile = join(repoRoot, "images", "readme-hero.webp");

await mkdir(join(repoRoot, "images"), { recursive: true });
await writeFile(outFile, webp);

console.log(
  `[readme-hero] wrote ${path.relative(process.cwd(), outFile)} (${README_HERO_W}x${README_HERO_H}, ${(webp.byteLength / 1024).toFixed(1)} KiB)`,
);
