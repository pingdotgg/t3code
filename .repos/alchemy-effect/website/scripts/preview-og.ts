/**
 * One-shot preview generator for the blog OG card. Renders a sample
 * card to /tmp/og-preview.png using the same Takumi pipeline
 * as the production endpoint.
 */
import { writeFile } from "node:fs/promises";
import { render } from "takumi-js";
import { brandFonts } from "../src/brand/fonts.ts";
import { OgCard } from "../src/brand/OgCard.tsx";

const element = OgCard({
  kind: "blog",
  title: "What's new in beta.39",
  description:
    "A small, high-impact fix release — VITE_* env props are now inlined into the client bundle, the Cloudflare Worker HTTP adapter runs handlers through Effect's standard HTTP lifecycle (unblocking RpcServer.toHttpEffect), and the SendEmail binding from beta.38 is now wired into Worker binding inference.",
  date: "2026-05-13",
});

const png = await render(element, {
  width: 1200,
  height: 630,
  format: "png",
  fonts: brandFonts,
  emoji: "from-font",
});

const out = "/tmp/og-preview.png";
await writeFile(out, png);
console.log(`wrote ${out}`);
