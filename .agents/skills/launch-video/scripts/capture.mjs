#!/usr/bin/env node
// Renders a story page frame by frame: every animation is paused and seeked, so output is deterministic.
// Usage: capture.mjs <story.html> <outDir> [--at <seconds,...>] [--fps 30]
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const at = flag("--at");
const fps = Number(flag("--fps") ?? 30);
const [html, outDir] = args;
if (!html || !outDir) {
  console.error("usage: capture.mjs <story.html> <outDir> [--at <seconds,...>] [--fps 30]");
  process.exit(2);
}

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const loadChromium = () => {
  const require = NodeModule.createRequire(NodePath.join(repoRoot, "scripts/package.json"));
  try {
    return require("playwright-core").chromium;
  } catch {
    console.error(`playwright-core is not installed in ${repoRoot}. Run \`vp i\` there first.`);
    process.exit(1);
  }
};
const chromium = loadChromium();

// Playwright's pinned revision is often not downloaded; any cached Chromium renders the same CSS.
const findChrome = () => {
  if (process.env.CHROME) return process.env.CHROME;
  const pinned = chromium.executablePath();
  if (NodeFS.existsSync(pinned)) return pinned;
  const caches = [".cache/ms-playwright", "Library/Caches/ms-playwright"]
    .map((d) => NodePath.join(NodeOS.homedir(), d))
    .filter(NodeFS.existsSync);
  const builds = caches
    .flatMap((cache) =>
      NodeFS.readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .map((d) => ({ cache, d, rev: Number(d.split("-")[1]) })),
    )
    .sort((a, b) => b.rev - a.rev);
  const candidates = builds.flatMap(({ cache, d }) => [
    NodePath.join(cache, d, "chrome-linux64/chrome"),
    NodePath.join(cache, d, "chrome-linux/chrome"),
    NodePath.join(cache, d, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"),
    NodePath.join(cache, d, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
  ]);
  const found = candidates.find(NodeFS.existsSync);
  if (!found) {
    console.error(
      "No Chromium found. Set CHROME=/path/to/chrome or run `vp exec playwright install chromium` in apps/web.",
    );
    process.exit(1);
  }
  return found;
};

if (!at) NodeFS.rmSync(outDir, { recursive: true, force: true });
NodeFS.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) => errors.push(`failed to load ${r.url()}`));
  await page.goto(NodeURL.pathToFileURL(NodePath.resolve(html)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const layout = (window.layoutTime ?? 15) * 1000;
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = layout;
    }
    window.placeCursor?.();
  });
  if (errors.length) throw new Error(`story page errors:\n${errors.join("\n")}`);
  const total = await page.evaluate(() => window.totalDuration);
  if (!total) throw new Error("story must set window.totalDuration (Kit.timeline does this)");

  const indices = at
    ? at.split(",").map((s) => Math.min(Math.round(Number(s) * fps), Math.round(total * fps) - 1))
    : [...Array(Math.round(total * fps)).keys()];
  for (const i of indices) {
    await page.evaluate((t) => {
      const ms = (window.warp ? window.warp(t) : t) * 1000;
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
    }, i / fps);
    const name = at
      ? `t${(i / fps).toFixed(2).padStart(6, "0")}.png`
      : `f${String(i).padStart(4, "0")}.png`;
    await page.screenshot({ path: NodePath.join(outDir, name) });
  }
  console.log(`${indices.length} frame(s) -> ${outDir} (video length ${total.toFixed(1)}s)`);
} finally {
  await browser.close();
}
