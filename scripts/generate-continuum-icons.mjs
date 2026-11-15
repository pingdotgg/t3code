#!/usr/bin/env node
// Renders every desktop and web icon from the vector mark below: node scripts/generate-continuum-icons.mjs
// Mobile icons and Icon Composer projects stay upstream's; Continuum ships no mobile app.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

const repoRoot = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "..");
const require = NodeModule.createRequire(NodePath.join(repoRoot, "scripts", "package.json"));
const sharp = require("sharp");

const VARIANTS = {
  prod: { background: ["#0b1220", "#151d33"], ring: ["#2dd4bf", "#818cf8"], dot: "#e0f2fe" },
  dev: { background: ["#0c2a5b", "#123b7a"], ring: ["#7dd3fc", "#e0f2fe"], dot: "#ffffff" },
  nightly: { background: ["#1e0b3a", "#33125c"], ring: ["#f472b6", "#fbbf24"], dot: "#fff7ed" },
};

function polar(cx, cy, r, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
}

/** The Continuum mark: an open ring that keeps going, with a dot where it continues. */
function markSvg(variant, { size, inset, radius, shadow }) {
  const v = VARIANTS[variant];
  const body = size - inset * 2;
  const cx = size / 2;
  const cy = size / 2;
  const ringRadius = body * 0.29;
  const stroke = body * 0.125;
  const [sx, sy] = polar(cx, cy, ringRadius, 42);
  const [ex, ey] = polar(cx, cy, ringRadius, 318);
  const [dx, dy] = polar(cx, cy, ringRadius, 0);
  const shadowFilter = shadow
    ? `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${size * 0.012}" stdDeviation="${size * 0.018}" flood-color="#000" flood-opacity="0.45"/></filter>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${v.background[0]}"/>
      <stop offset="1" stop-color="${v.background[1]}"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${v.ring[0]}"/>
      <stop offset="1" stop-color="${v.ring[1]}"/>
    </linearGradient>
    ${shadowFilter}
  </defs>
  <rect x="${inset}" y="${inset}" width="${body}" height="${body}" rx="${radius}" fill="url(#bg)"${shadow ? ' filter="url(#s)"' : ""}/>
  <path d="M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${ringRadius} ${ringRadius} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}" fill="none" stroke="url(#ring)" stroke-width="${stroke}" stroke-linecap="round"/>
  <circle cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="${(stroke * 0.52).toFixed(2)}" fill="${v.dot}"/>
</svg>`;
}

const fullBleed = (variant, size) =>
  markSvg(variant, { size, inset: 0, radius: size * 0.225, shadow: false });
// macOS pre-Tahoe safe area: an 824/1024 body inset 100/1024 on every side.
const macos = (variant, size) =>
  markSvg(variant, {
    size,
    inset: Math.round((size * 100) / 1024),
    radius: (size * 185) / 1024,
    shadow: true,
  });

async function png(svg, size) {
  return sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/** ICO files may embed PNG images directly (Windows Vista and newer). */
async function ico(variant, sizes) {
  const images = await Promise.all(sizes.map((size) => png(fullBleed(variant, 256), size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  return Buffer.concat([header, ...images]);
}

const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const FAVICON_ICO_SIZES = [16, 32, 48];

const OUTPUTS = {
  prod: {
    dir: "assets/prod",
    universal: "black-universal-1024.png",
    macos: "black-macos-1024.png",
    windowsIco: "t3-black-windows.ico",
    web: "t3-black-web",
  },
  dev: {
    dir: "assets/dev",
    universal: "blueprint-universal-1024.png",
    macos: "blueprint-macos-1024.png",
    windowsIco: "blueprint-windows.ico",
    web: "blueprint-web",
  },
  nightly: {
    dir: "assets/nightly",
    universal: "nightly-universal-1024.png",
    macos: "nightly-macos-1024.png",
    windowsIco: "nightly-windows.ico",
    web: "nightly-web",
  },
};

async function writeVariant(variant) {
  const out = OUTPUTS[variant];
  const at = (name) => NodePath.join(repoRoot, out.dir, name);
  const write = (name, data) => NodeFS.writeFileSync(at(name), data);
  write(out.universal, await png(fullBleed(variant, 1024), 1024));
  write(out.macos, await png(macos(variant, 1024), 1024));
  write(out.windowsIco, await ico(variant, WINDOWS_ICO_SIZES));
  write(`${out.web}-favicon.ico`, await ico(variant, FAVICON_ICO_SIZES));
  write(`${out.web}-favicon-16x16.png`, await png(fullBleed(variant, 256), 16));
  write(`${out.web}-favicon-32x32.png`, await png(fullBleed(variant, 256), 32));
  write(`${out.web}-apple-touch-180.png`, await png(fullBleed(variant, 512), 180));
  write(`${out.web}-icon-192x192.png`, await png(fullBleed(variant, 512), 192));
  write(`${out.web}-icon-512x512.png`, await png(fullBleed(variant, 512), 512));
  return out;
}

for (const variant of Object.keys(OUTPUTS)) {
  await writeVariant(variant);
}

// Vector sources for docs and the README.
NodeFS.mkdirSync(NodePath.join(repoRoot, "assets/continuum"), { recursive: true });
NodeFS.writeFileSync(NodePath.join(repoRoot, "assets/continuum/logo.svg"), fullBleed("prod", 128));
NodeFS.writeFileSync(NodePath.join(repoRoot, "assets/prod/logo.svg"), fullBleed("prod", 128));

// The dev server serves apps/web/public; mirror the development set there.
const publicDir = NodePath.join(repoRoot, "apps/web/public");
const devWeb = (suffix) => NodePath.join(repoRoot, "assets/dev", `blueprint-web${suffix}`);
NodeFS.copyFileSync(devWeb("-favicon.ico"), NodePath.join(publicDir, "favicon.ico"));
NodeFS.copyFileSync(devWeb("-favicon-16x16.png"), NodePath.join(publicDir, "favicon-16x16.png"));
NodeFS.copyFileSync(devWeb("-favicon-32x32.png"), NodePath.join(publicDir, "favicon-32x32.png"));
NodeFS.copyFileSync(
  devWeb("-apple-touch-180.png"),
  NodePath.join(publicDir, "apple-touch-icon.png"),
);
NodeFS.copyFileSync(devWeb("-icon-192x192.png"), NodePath.join(publicDir, "icon-192x192.png"));
NodeFS.copyFileSync(devWeb("-icon-512x512.png"), NodePath.join(publicDir, "icon-512x512.png"));

console.log("Continuum icons written.");
