/**
 * Renders the repo-root README hero image. Run once (or whenever the
 * brand mark / wordmark changes) and the resulting PNG is committed to
 * `images/readme-hero.png`. GitHub serves it straight out of the tree.
 *
 * Pipeline mirrors the per-page OG image endpoint
 * (`src/pages/og/[...slug].png.ts`): satori → SVG → resvg → PNG, with
 * the same static TTF fonts loaded from `website/assets/fonts/` so the
 * artwork uses the website's headline face (Source Serif 4 Display)
 * instead of a fallback.
 */

import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import {
  README_HERO_H,
  README_HERO_W,
  ReadmeHero,
} from "../src/brand/ReadmeHero.tsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(here, "../assets/fonts");
const outDir = path.resolve(here, "../../images");
const outFile = path.join(outDir, "readme-hero.png");

async function font(file: string): Promise<Buffer> {
  return readFile(path.join(fontsDir, file));
}

async function main() {
  const [serifIt, displayLightIt, displaySemiIt, displayReg, mono, caveat] =
    await Promise.all([
      font("SourceSerif4-It.ttf"),
      font("SourceSerif4Display-LightIt.ttf"),
      font("SourceSerif4Display-SemiboldIt.ttf"),
      font("SourceSerif4Display-Regular.ttf"),
      font("JetBrainsMono-Regular.ttf"),
      font("Caveat-Regular.ttf"),
    ]);

  const fonts = [
    { name: "Source Serif 4", data: serifIt, weight: 400, style: "italic" },
    {
      name: "Source Serif 4 Display",
      data: displayLightIt,
      weight: 300,
      style: "italic",
    },
    {
      name: "Source Serif 4 Display",
      data: displayReg,
      weight: 400,
      style: "normal",
    },
    {
      name: "Source Serif 4 Display",
      data: displaySemiIt,
      weight: 600,
      style: "italic",
    },
    { name: "JetBrains Mono", data: mono, weight: 400, style: "normal" },
    { name: "Caveat", data: caveat, weight: 400, style: "normal" },
  ] as const;

  const svg = await satori(ReadmeHero(), {
    width: README_HERO_W,
    height: README_HERO_H,
    fonts: fonts as any,
  });

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: README_HERO_W },
  })
    .render()
    .asPng();

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, png);

  // eslint-disable-next-line no-console
  console.log(
    `[readme-hero] wrote ${path.relative(process.cwd(), outFile)} (${README_HERO_W}×${README_HERO_H}, ${(png.byteLength / 1024).toFixed(1)} KiB)`,
  );
}

await main();
