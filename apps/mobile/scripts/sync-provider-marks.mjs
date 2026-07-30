#!/usr/bin/env node

// Derives the widget extension's provider marks from the web app's icons.
//
// The Live Activity resolves its marks through an asset catalog (`Image
// assetName`), so it cannot import the React components in
// apps/web/src/components/Icons.tsx. Rather than hand-copy the path data and let
// it drift, generate the SVGs from that file and verify them in CI.
//
//   node scripts/sync-provider-marks.mjs           # write
//   node scripts/sync-provider-marks.mjs --check    # verify, exit 1 on drift

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const MOBILE_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = NodePath.resolve(MOBILE_ROOT, "../..");
const ICONS_SOURCE = NodePath.join(REPO_ROOT, "apps/web/src/components/Icons.tsx");
const OUTPUT_DIR = NodePath.join(MOBILE_ROOT, "assets/widget");

// Asset name -> the exported icon it comes from. The asset names are what
// withWidgetLogoAsset.cjs ships and what the widget layouts ask for; the
// components mirror PROVIDER_ICON_BY_PROVIDER in providerIconUtils.ts.
const MARKS = [
  { asset: "Codex", component: "OpenAI" },
  { asset: "Claude", component: "ClaudeAI" },
  { asset: "Cursor", component: "CursorIcon" },
  { asset: "Grok", component: "GrokIcon" },
  { asset: "OpenCode", component: "OpenCodeIcon" },
];

// Cursor's mark is one path holding the outer cube and the inner facet. Nonzero
// winding fills both and collapses it to a featureless block, so it needs
// even-odd for the facet to cut through.
const EVEN_ODD = new Set(["Cursor"]);
// OpenCode's mark is a frame plus a dimmer inner block. A template image is a
// single colour, so the inner block is carried at partial opacity instead.
const INNER_BLOCK_OPACITY = "0.45";

function componentBlock(source, name) {
  const start = source.indexOf(`export const ${name}: Icon`);
  if (start === -1) throw new Error(`Icons.tsx no longer exports ${name}`);
  const end = source.indexOf("\nexport const ", start + 10);
  return source.slice(start, end === -1 ? undefined : end);
}

function viewBox(block, name) {
  const match = /viewBox="([^"]+)"/.exec(block);
  if (!match) throw new Error(`${name} has no viewBox`);
  return match[1];
}

function pathTags(block) {
  return [...block.matchAll(/<path\b([^>]*?)\/>/gs)].map((match) => match[1]);
}

function pathData(attributes, name) {
  const match = /d="([^"]+)"/s.exec(attributes);
  if (!match) throw new Error(`${name} has a <path> without a d attribute`);
  return match[1];
}

function renderSvg({ asset, block }) {
  const box = viewBox(block, asset);
  const [, , width, height] = box.split(/\s+/);
  const fillRule = EVEN_ODD.has(asset) ? ' fill-rule="evenodd"' : "";

  let paths;
  if (asset === "OpenCode") {
    // Icons.tsx carries a light and a dark pair toggled by className; take the
    // dark one, whose frame is the light shape on a dark surface.
    const dark = pathTags(block).filter((attributes) => attributes.includes("dark:block"));
    if (dark.length !== 2) {
      throw new Error(`OpenCodeIcon no longer has exactly two dark-mode paths (${dark.length})`);
    }
    const [inner, frame] = dark;
    paths = [
      `  <path fill="currentColor" fill-opacity="${INNER_BLOCK_OPACITY}" d="${pathData(inner, asset)}"/>`,
      `  <path fill="currentColor" d="${pathData(frame, asset)}"/>`,
    ];
  } else {
    paths = pathTags(block).map(
      (attributes) => `  <path fill="currentColor"${fillRule} d="${pathData(attributes, asset)}"/>`,
    );
  }
  if (paths.length === 0) throw new Error(`${asset} produced no paths`);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${box}">\n${paths.join("\n")}\n</svg>\n`
  );
}

const checkOnly = NodeProcess.argv.includes("--check");
const source = await NodeFSP.readFile(ICONS_SOURCE, "utf8");

const drifted = [];
let written = 0;
for (const mark of MARKS) {
  const svg = renderSvg({ asset: mark.asset, block: componentBlock(source, mark.component) });
  const target = NodePath.join(OUTPUT_DIR, `${mark.asset}.svg`);
  const current = await NodeFSP.readFile(target, "utf8").catch(() => null);
  if (current === svg) continue;
  if (checkOnly) {
    drifted.push(mark.asset);
    continue;
  }
  await NodeFSP.mkdir(OUTPUT_DIR, { recursive: true });
  await NodeFSP.writeFile(target, svg);
  written += 1;
  console.log(`updated ${NodePath.relative(REPO_ROOT, target)}`);
}

if (checkOnly && drifted.length > 0) {
  console.error(
    `Provider marks are out of date with Icons.tsx: ${drifted.join(", ")}.\n` +
      "Run `vp run --filter @t3tools/mobile sync:provider-marks` and commit the result.",
  );
  NodeProcess.exit(1);
}
console.log(
  checkOnly
    ? `All ${MARKS.length} provider marks are current.`
    : written === 0
      ? `All ${MARKS.length} provider marks were already current.`
      : `Updated ${written} of ${MARKS.length} provider marks.`,
);
