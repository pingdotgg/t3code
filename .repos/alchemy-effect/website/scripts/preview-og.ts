/**
 * One-shot preview generator for the blog OG card. Renders a sample
 * card to /tmp/og-preview.png using the same satori + resvg pipeline
 * as the production endpoint.
 */
import { Resvg } from "@resvg/resvg-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { OgCard } from "../src/brand/OgCard";

const fontsDir = fileURLToPath(new URL("../assets/fonts/", import.meta.url));
const publicFontsDir = fileURLToPath(
  new URL("../public/fonts/", import.meta.url),
);
const read = (name: string, pub = false) =>
  fs.readFile(path.join(pub ? publicFontsDir : fontsDir, name));

const [
  serif,
  serifIt,
  displayLight,
  displayLightIt,
  displayReg,
  displayRegIt,
  displaySemi,
  displaySemiIt,
  tinos,
  mono,
  caveat,
] = await Promise.all([
  read("SourceSerif4-Regular.ttf"),
  read("SourceSerif4-It.ttf"),
  read("SourceSerif4Display-Light.ttf"),
  read("SourceSerif4Display-LightIt.ttf"),
  read("SourceSerif4Display-Regular.ttf"),
  read("SourceSerif4Display-It.ttf"),
  read("SourceSerif4Display-Semibold.ttf"),
  read("SourceSerif4Display-SemiboldIt.ttf"),
  read("Tinos-Regular.ttf", true),
  read("JetBrainsMono-Regular.ttf"),
  read("Caveat-Regular.ttf"),
]);

const fonts = [
  { name: "Source Serif 4", data: serif, weight: 400, style: "normal" },
  { name: "Source Serif 4", data: serifIt, weight: 400, style: "italic" },
  {
    name: "Source Serif 4 Display",
    data: displayLight,
    weight: 300,
    style: "normal",
  },
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
    data: displayRegIt,
    weight: 400,
    style: "italic",
  },
  {
    name: "Source Serif 4 Display",
    data: displaySemi,
    weight: 600,
    style: "normal",
  },
  {
    name: "Source Serif 4 Display",
    data: displaySemiIt,
    weight: 600,
    style: "italic",
  },
  { name: "Tinos", data: tinos, weight: 400, style: "normal" },
  { name: "JetBrains Mono", data: mono, weight: 400, style: "normal" },
  { name: "Caveat", data: caveat, weight: 400, style: "normal" },
] as const;

const element = OgCard({
  kind: "blog",
  title: "What's new in beta.39",
  description:
    "A small, high-impact fix release — VITE_* env props are now inlined into the client bundle, the Cloudflare Worker HTTP adapter runs handlers through Effect's standard HTTP lifecycle (unblocking RpcServer.toHttpEffect), and the SendEmail binding from beta.38 is now wired into Worker binding inference.",
  date: "2026-05-13",
});

const svg = await satori(element, {
  width: 1200,
  height: 630,
  fonts: fonts as any,
});
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
  .render()
  .asPng();

const out = "/tmp/og-preview.png";
await fs.writeFile(out, png);
console.log(`wrote ${out}`);
