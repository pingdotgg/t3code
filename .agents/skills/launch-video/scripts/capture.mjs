#!/usr/bin/env node
// Renders a story page frame by frame: every animation is paused and seeked, so output is deterministic.
// Usage: capture.mjs <story.html> <outDir> [--at <seconds,...>] [--fps 30]
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { findChrome } from "./chrome.mjs";
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

// Served over HTTP, not file://, so the story can reach into its beat iframes.
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};
const root = NodePath.dirname(NodePath.resolve(html));
const server = NodeHttp.createServer((req, res) => {
  const file = NodePath.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  NodeFS.readFile(file, (error, body) => {
    if (error) return void res.writeHead(404).end();
    res
      .writeHead(200, {
        "content-type": TYPES[NodePath.extname(file)] ?? "application/octet-stream",
      })
      .end(body);
  });
}).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

// Every animation in the story and in its beat iframes, paused at `ms`.
const seek = (ms) => {
  const docs = [
    document,
    ...[...document.querySelectorAll("iframe")].map((f) => f.contentDocument).filter(Boolean),
  ];
  for (const doc of docs)
    for (const a of doc.getAnimations()) {
      a.pause();
      a.currentTime = ms;
    }
};

if (!at) NodeFS.rmSync(outDir, { recursive: true, force: true });
NodeFS.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: findChrome(chromium),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) => errors.push(`failed to load ${r.url()}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/${NodePath.basename(html)}`);
  await page.evaluate(async () => {
    await window.Kit?.ready;
    await document.fonts.ready;
    window.setup?.();
  });
  await page.evaluate(
    ([seekSource]) => {
      window.__seek = new Function(`return ${seekSource}`)();
      window.__seek((window.layoutTime ?? 15) * 1000);
      window.placeCursor?.();
    },
    [seek.toString()],
  );
  if (errors.length) throw new Error(`story page errors:\n${errors.join("\n")}`);
  const total = await page.evaluate(() => window.totalDuration);
  if (!total) throw new Error("story must set window.totalDuration (Kit.timeline does this)");

  const indices = at
    ? at.split(",").map((s) => Math.min(Math.round(Number(s) * fps), Math.round(total * fps) - 1))
    : [...Array(Math.round(total * fps)).keys()];
  for (const i of indices) {
    await page.evaluate((t) => window.__seek((window.warp ? window.warp(t) : t) * 1000), i / fps);
    const name = at
      ? `t${(i / fps).toFixed(2).padStart(6, "0")}.png`
      : `f${String(i).padStart(4, "0")}.png`;
    await page.screenshot({ path: NodePath.join(outDir, name) });
  }
  console.log(`${indices.length} frame(s) -> ${outDir} (video length ${total.toFixed(1)}s)`);
} finally {
  await browser.close();
  server.close();
}
