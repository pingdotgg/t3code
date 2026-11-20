#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-off asset generator run by hand.
/**
 * Builds Conn's mobile icons from the icon set's 24px solid glyphs, for every SF name in its
 * manifest (`sf` in assets/conn/superheroicons/manifest.json): iOS custom symbols (see
 * ConnSymbols.swift), template PNGs for native header buttons, and the Android glyph module.
 * Run it after changing the set and commit the output: `node scripts/build-conn-symbols.ts`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const moduleDir = NodePath.join(repoRoot, "apps/mobile/modules/conn-symbols");
const catalog = NodePath.join(moduleDir, "ios/ConnSymbols.xcassets");
const setDir = NodePath.join(repoRoot, "assets/conn/superheroicons");

// SF Symbols template geometry (points at a 100pt font, template v2 "M" row).
const BASELINE_M = 1126;
const CAPLINE_M = 1055.54;
// Mobile draws the 24px solid set. Its 24-unit box maps to 98 units: the ~20-unit drawing then
// reads about the size of an SF Symbol, centred on the middle of the cap height.
const GLYPH_BOX = 24;
const BOX = 98;
const SCALE = BOX / GLYPH_BOX;
const TOP = -(BASELINE_M - CAPLINE_M) / 2 - BOX / 2;
const LEFT = 1500;

/** Scales a path from the glyph box to the symbol box. */
function transformPath(d: string): string {
  const mirrored = false;
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: string[] = [];
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  const ax = (x: number) => (mirrored ? BOX - x * SCALE : x * SCALE);
  const ay = (y: number) => TOP + y * SCALE;
  const rx = (dx: number) => (mirrored ? -dx : dx) * SCALE;
  const ry = (dy: number) => dy * SCALE;
  let command = "";
  let i = 0;
  const next = () => Number(tokens[i++]);
  // A path's leading `m` moves to an absolute point; its implicit pairs after that stay relative.
  if (tokens[0] === "m") {
    i = 1;
    out.push("M", fmt(ax(next())), fmt(ay(next())));
    command = "l";
    if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i]!)) out.push("l");
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) {
      command = tokens[i++]!;
      out.push(command);
      if (command === "Z" || command === "z") continue;
    }
    const relative = command === command.toLowerCase();
    const x = relative ? rx : ax;
    const y = relative ? ry : ay;
    switch (command.toUpperCase()) {
      case "M":
      case "L":
      case "T":
        out.push(fmt(x(next())), fmt(y(next())));
        break;
      case "H":
        out.push(fmt(x(next())));
        break;
      case "V":
        out.push(fmt(y(next())));
        break;
      case "C":
        for (let k = 0; k < 3; k++) out.push(fmt(x(next())), fmt(y(next())));
        break;
      case "S":
      case "Q":
        for (let k = 0; k < 2; k++) out.push(fmt(x(next())), fmt(y(next())));
        break;
      case "A": {
        const radiusX = next() * SCALE;
        const radiusY = next() * SCALE;
        const rotation = next();
        const largeArc = next();
        const sweep = next();
        out.push(
          fmt(radiusX),
          fmt(radiusY),
          fmt(mirrored ? -rotation : rotation),
          String(largeArc),
          String(mirrored ? 1 - sweep : sweep),
          fmt(x(next())),
          fmt(y(next())),
        );
        break;
      }
      default:
        throw new Error(`Unsupported path command ${command}`);
    }
  }
  return out.join(" ");
}

// iOS custom symbols fill with the nonzero rule and ignore `fill-rule: evenodd`, which most
// glyphs use for their cut-outs. So each evenodd path is rewritten for nonzero: every subpath
// nested inside an odd number of others runs the opposite way to its container.
type Point = readonly [number, number];
type Segment =
  | { readonly kind: "L"; readonly to: Point }
  | { readonly kind: "C"; readonly c1: Point; readonly c2: Point; readonly to: Point }
  | { readonly kind: "Q"; readonly c: Point; readonly to: Point }
  | {
      readonly kind: "A";
      readonly rx: number;
      readonly ry: number;
      readonly rotation: number;
      readonly large: number;
      readonly sweep: number;
      readonly to: Point;
    };
interface Subpath {
  readonly start: Point;
  readonly segments: Segment[];
}

/** Parses a path into closed-or-open subpaths of absolute L, C, Q and A segments. */
function parseSubpaths(d: string): Subpath[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const subpaths: Subpath[] = [];
  let i = 0;
  let command = "";
  let current: Point = [0, 0];
  let start: Point = [0, 0];
  let lastControl: Point | null = null;
  let lastKind = "";
  let sub: Subpath | null = null;
  const num = () => Number(tokens[i++]);
  const isNumber = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i]!);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) command = tokens[i++]!;
    const rel = command === command.toLowerCase();
    const pt = (): Point => {
      const x = num();
      const y = num();
      return rel ? [current[0] + x, current[1] + y] : [x, y];
    };
    const upper = command.toUpperCase();
    if (upper === "Z") {
      current = start;
      sub = null;
      lastKind = "Z";
      continue;
    }
    if (upper === "M") {
      current = pt();
      start = current;
      sub = { start, segments: [] };
      subpaths.push(sub);
      command = rel ? "l" : "L";
      lastKind = "M";
      continue;
    }
    if (sub === null) {
      sub = { start: current, segments: [] };
      start = current;
      subpaths.push(sub);
    }
    let segment: Segment;
    switch (upper) {
      case "L":
        segment = { kind: "L", to: pt() };
        break;
      case "H": {
        const x = num();
        segment = { kind: "L", to: [rel ? current[0] + x : x, current[1]] };
        break;
      }
      case "V": {
        const y = num();
        segment = { kind: "L", to: [current[0], rel ? current[1] + y : y] };
        break;
      }
      case "C": {
        const c1 = pt();
        const c2 = pt();
        segment = { kind: "C", c1, c2, to: pt() };
        break;
      }
      case "S": {
        const c1: Point =
          lastKind === "C" && lastControl
            ? [2 * current[0] - lastControl[0], 2 * current[1] - lastControl[1]]
            : current;
        const c2 = pt();
        segment = { kind: "C", c1, c2, to: pt() };
        break;
      }
      case "Q": {
        const c = pt();
        segment = { kind: "Q", c, to: pt() };
        break;
      }
      case "T": {
        const c: Point =
          lastKind === "Q" && lastControl
            ? [2 * current[0] - lastControl[0], 2 * current[1] - lastControl[1]]
            : current;
        segment = { kind: "Q", c, to: pt() };
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rotation = num();
        const large = num();
        const sweep = num();
        segment = { kind: "A", rx, ry, rotation, large, sweep, to: pt() };
        break;
      }
      default:
        throw new Error(`Unsupported path command ${command}`);
    }
    sub.segments.push(segment);
    lastKind = segment.kind;
    lastControl = segment.kind === "C" ? segment.c2 : segment.kind === "Q" ? segment.c : null;
    current = segment.to;
    if (!isNumber() && i < tokens.length && /[a-zA-Z]/.test(tokens[i]!)) continue;
  }
  return subpaths;
}

/** Points along a subpath, close enough for orientation and containment. */
function sample(sub: Subpath): Point[] {
  const points: Point[] = [sub.start];
  let from = sub.start;
  for (const s of sub.segments) {
    if (s.kind === "L") points.push(s.to);
    else if (s.kind === "C" || s.kind === "Q") {
      for (let k = 1; k <= 12; k++) {
        const t = k / 12;
        const u = 1 - t;
        points.push(
          s.kind === "C"
            ? [
                u * u * u * from[0] +
                  3 * u * u * t * s.c1[0] +
                  3 * u * t * t * s.c2[0] +
                  t * t * t * s.to[0],
                u * u * u * from[1] +
                  3 * u * u * t * s.c1[1] +
                  3 * u * t * t * s.c2[1] +
                  t * t * t * s.to[1],
              ]
            : [
                u * u * from[0] + 2 * u * t * s.c[0] + t * t * s.to[0],
                u * u * from[1] + 2 * u * t * s.c[1] + t * t * s.to[1],
              ],
        );
      }
    } else {
      points.push(...sampleArc(from, s));
    }
    from = s.to;
  }
  return points;
}

/** Samples an SVG arc via its centre parameterisation (SVG 1.1, F.6.5). */
function sampleArc(from: Point, a: Extract<Segment, { kind: "A" }>): Point[] {
  const phi = (a.rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from[0] - a.to[0]) / 2;
  const dy = (from[1] - a.to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  let rx = Math.abs(a.rx);
  let ry = Math.abs(a.ry);
  if (rx === 0 || ry === 0) return [a.to];
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (a.large === a.sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + a.to[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (from[1] + a.to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!a.sweep && delta > 0) delta -= 2 * Math.PI;
  if (a.sweep && delta < 0) delta += 2 * Math.PI;
  const points: Point[] = [];
  for (let k = 1; k <= 16; k++) {
    const t = theta + (delta * k) / 16;
    const px = rx * Math.cos(t);
    const py = ry * Math.sin(t);
    points.push([cos * px - sin * py + cx, sin * px + cos * py + cy]);
  }
  return points;
}

const signedArea = (points: Point[]) =>
  points.reduce((sum, p, k) => {
    const q = points[(k + 1) % points.length]!;
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

function contains(polygon: Point[], p: Point): boolean {
  let inside = false;
  for (let k = 0, j = polygon.length - 1; k < polygon.length; j = k++) {
    const [xi, yi] = polygon[k]!;
    const [xj, yj] = polygon[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function reverse(sub: Subpath): Subpath {
  const points = [sub.start, ...sub.segments.map((s) => s.to)];
  const segments: Segment[] = [];
  for (let k = sub.segments.length - 1; k >= 0; k--) {
    const s = sub.segments[k]!;
    const to = points[k]!;
    if (s.kind === "L") segments.push({ kind: "L", to });
    else if (s.kind === "C") segments.push({ kind: "C", c1: s.c2, c2: s.c1, to });
    else if (s.kind === "Q") segments.push({ kind: "Q", c: s.c, to });
    else segments.push({ ...s, sweep: s.sweep ? 0 : 1, to });
  }
  return { start: points[points.length - 1]!, segments };
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000);
const p = (pt: Point) => `${fmt(pt[0])} ${fmt(pt[1])}`;
function serialize(subs: Subpath[]): string {
  return subs
    .map(
      (sub) =>
        `M${p(sub.start)}` +
        sub.segments
          .map((s) =>
            s.kind === "L"
              ? `L${p(s.to)}`
              : s.kind === "C"
                ? `C${p(s.c1)} ${p(s.c2)} ${p(s.to)}`
                : s.kind === "Q"
                  ? `Q${p(s.c)} ${p(s.to)}`
                  : `A${fmt(s.rx)} ${fmt(s.ry)} ${fmt(s.rotation)} ${s.large} ${s.sweep} ${p(s.to)}`,
          )
          .join("") +
        "Z",
    )
    .join("");
}

/** Rewrites an evenodd path so the nonzero rule fills the same area. */
function evenOddToNonzero(d: string): string {
  const subs = parseSubpaths(d);
  const polygons = subs.map(sample);
  return serialize(
    subs.map((sub, k) => {
      const probe = polygons[k]![0]!;
      const depth = polygons.filter((other, j) => j !== k && contains(other, probe)).length;
      const clockwise = signedArea(polygons[k]!) > 0;
      return clockwise === (depth % 2 === 0) ? sub : reverse(sub);
    }),
  );
}

interface SymbolPath {
  readonly d: string;
  readonly evenOdd: boolean;
}

function symbolSvg(paths: readonly SymbolPath[]): string {
  const guide = 'style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;"';
  const margin = (id: string, x: number) =>
    `<line id="${id}" ${guide} x1="${x}" x2="${x}" y1="${BASELINE_M - 100}" y2="${BASELINE_M + 20}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="3300" height="2200">
 <g id="Notes">
  <text id="template-version" x="3036" y="1933">Template v.2.0</text>
 </g>
 <g id="Guides">
  <line id="Baseline-S" ${guide} x1="263" x2="3036" y1="696" y2="696"/>
  <line id="Capline-S" ${guide} x1="263" x2="3036" y1="625.541" y2="625.541"/>
  <line id="Baseline-M" ${guide} x1="263" x2="3036" y1="${BASELINE_M}" y2="${BASELINE_M}"/>
  <line id="Capline-M" ${guide} x1="263" x2="3036" y1="${CAPLINE_M}" y2="${CAPLINE_M}"/>
  <line id="Baseline-L" ${guide} x1="263" x2="3036" y1="1556" y2="1556"/>
  <line id="Capline-L" ${guide} x1="263" x2="3036" y1="1485.54" y2="1485.54"/>
  ${margin("left-margin-Regular-M", LEFT)}
  ${margin("right-margin-Regular-M", LEFT + BOX)}
 </g>
 <g id="Symbols">
  <g id="Regular-M" transform="matrix(1 0 0 1 ${LEFT} ${BASELINE_M})">
${paths.map((p) => `   <path${p.evenOdd ? ' style="fill-rule:evenodd;"' : ""} d="${p.d}"/>`).join("\n")}
  </g>
 </g>
</svg>
`;
}

const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(setDir, "manifest.json"), "utf8"),
) as { readonly sf: Readonly<Record<string, string>> };

/** Reads a glyph's paths in its 24-unit box; a rect becomes a rounded-rect path. */
function readGlyph(concept: string): SymbolPath[] {
  const file = NodePath.join(setDir, `${GLYPH_BOX}/solid`, `${concept}.svg`);
  if (!NodeFS.existsSync(file)) throw new Error(`no glyph for concept "${concept}" (${file})`);
  const svg = NodeFS.readFileSync(file, "utf8");
  const paths: SymbolPath[] = [];
  for (const [, tag, raw] of svg.matchAll(/<(path|rect)\b([^>]*?)\/>/g)) {
    const attrs = Object.fromEntries(
      [...raw!.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    const evenOdd = attrs["fill-rule"] === "evenodd";
    if (tag === "path") {
      paths.push({ d: attrs.d!, evenOdd });
    } else {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((key) => Number(attrs[key] ?? 0)) as [
        number,
        number,
        number,
        number,
      ];
      const r = Math.min(Number(attrs.rx ?? 0), w / 2, h / 2);
      const d = `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
      paths.push({ d, evenOdd });
    }
  }
  if (paths.length === 0) throw new Error(`${file}: no paths`);
  return STEPPED_CONCEPTS.has(concept)
    ? paths.map((p) => ({ ...p, d: scaleAboutCentre(p.d, STEP) }))
    : paths;
}

// Bare ×, + and … fill less of the box than the SF Symbols they replace; they draw one size step
// up (20 → 24) about the box centre, everywhere on mobile.
const STEPPED_CONCEPTS = new Set(["close", "add", "more-horizontal"]);
const STEP = 1.2;

function scaleAboutCentre(d: string, factor: number): string {
  const c = GLYPH_BOX / 2;
  const at = (pt: Point): Point => [c + (pt[0] - c) * factor, c + (pt[1] - c) * factor];
  return serialize(
    parseSubpaths(d).map((sub) => ({
      start: at(sub.start),
      segments: sub.segments.map((s) =>
        s.kind === "L"
          ? { kind: "L", to: at(s.to) }
          : s.kind === "C"
            ? { kind: "C", c1: at(s.c1), c2: at(s.c2), to: at(s.to) }
            : s.kind === "Q"
              ? { kind: "Q", c: at(s.c), to: at(s.to) }
              : { ...s, rx: s.rx * factor, ry: s.ry * factor, to: at(s.to) },
      ),
    })),
  );
}

/** A glyph as a black-on-transparent SVG in its 24-unit box. */
function glyphSvg(concept: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GLYPH_BOX} ${GLYPH_BOX}" fill="#000">${readGlyph(
    concept,
  )
    .map((p) => `<path${p.evenOdd ? ' fill-rule="evenodd"' : ""} d="${p.d}"/>`)
    .join("")}</svg>`;
}

NodeFS.rmSync(catalog, { recursive: true, force: true });
NodeFS.mkdirSync(catalog, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(catalog, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);

for (const [name, concept] of Object.entries(manifest.sf)) {
  const paths = readGlyph(concept).map((p) => ({
    evenOdd: false,
    d: transformPath(p.evenOdd ? evenOddToNonzero(p.d) : p.d),
  }));
  const dir = NodePath.join(catalog, `${name}.symbolset`);
  NodeFS.mkdirSync(dir);
  NodeFS.writeFileSync(NodePath.join(dir, `${name}.svg`), symbolSvg(paths));
  NodeFS.writeFileSync(
    NodePath.join(dir, "Contents.json"),
    `${JSON.stringify(
      {
        info: { author: "xcode", version: 1 },
        symbols: [{ filename: `${name}.svg`, idiom: "universal" }],
      },
      null,
      2,
    )}\n`,
  );
}

const names = Object.keys(manifest.sf).sort();
NodeFS.writeFileSync(
  NodePath.join(moduleDir, "ios/ConnSymbolNames.swift"),
  `// Generated by scripts/build-conn-symbols.ts from assets/conn/superheroicons. Do not edit.
let connSymbolNames: Set<String> = [
${names.map((name) => `  "${name}",`).join("\n")}
]
`,
);

// Android draws the same glyphs with react-native-svg (AppSymbol.android.tsx).
const camel = (concept: string) =>
  concept.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const concepts = [...new Set(Object.values(manifest.sf))].sort();
const androidOut = NodePath.join(repoRoot, "apps/mobile/src/components/ui/connGlyphs.generated.ts");
NodeFS.writeFileSync(
  androidOut,
  `// Generated by scripts/build-conn-symbols.ts from assets/conn/superheroicons. Do not edit.
import type { ConnGlyphData } from "./ConnGlyph";

${concepts.map((concept) => `const ${camel(concept)}Glyph = ${JSON.stringify(readGlyph(concept))} satisfies ConnGlyphData;`).join("\n")}

/** Glyph per SF Symbol name in the icon set's manifest. */
export const CONN_GLYPH_BY_SF_NAME = {
${names.map((name) => `  ${JSON.stringify(name)}: ${camel(manifest.sf[name]!)}Glyph,`).join("\n")}
} as const;
`,
);
NodeChildProcess.execFileSync("vp", ["fmt", androidOut], { cwd: repoRoot, stdio: "inherit" });

// Native header buttons take template images, tinted like SF Symbols: each concept black on
// transparent, the 24-unit glyph filling a 24pt canvas, at 1x, 2x and 3x.
const sharp = NodeModule.createRequire(NodePath.join(repoRoot, "scripts/package.json"))(
  "sharp",
) as (
  input: Buffer,
  options: { density: number },
) => { resize(w: number, h: number): { png(): { toBuffer(): Promise<Buffer> } } };
const headerDir = NodePath.join(repoRoot, "apps/mobile/assets/header-icons");
NodeFS.rmSync(headerDir, { recursive: true, force: true });
NodeFS.mkdirSync(headerDir, { recursive: true });
const HEADER_POINTS = 24;
for (const concept of concepts) {
  const svg = glyphSvg(concept);
  for (const scale of [1, 2, 3]) {
    const pixels = HEADER_POINTS * scale;
    const png = await sharp(Buffer.from(svg), { density: (72 * pixels * 2) / GLYPH_BOX })
      .resize(pixels, pixels)
      .png()
      .toBuffer();
    NodeFS.writeFileSync(
      NodePath.join(headerDir, `${concept}${scale === 1 ? "" : `@${scale}x`}.png`),
      png,
    );
  }
}
const headerOut = NodePath.join(repoRoot, "apps/mobile/src/native/connHeaderIcons.generated.ts");
NodeFS.writeFileSync(
  headerOut,
  `// Generated by scripts/build-conn-symbols.ts from assets/conn/superheroicons. Do not edit.
import type { ImageSourcePropType } from "react-native";

/** Template image per SF Symbol name in the icon set's manifest, for native header buttons. */
export const CONN_HEADER_ICON_BY_SF_NAME: Readonly<Record<string, ImageSourcePropType>> = {
${names.map((name) => `  ${JSON.stringify(name)}: require("../../assets/header-icons/${manifest.sf[name]}.png"),`).join("\n")}
};
`,
);
NodeChildProcess.execFileSync("vp", ["fmt", headerOut], { cwd: repoRoot, stdio: "inherit" });

console.log(`Wrote ${names.length} symbols to ${NodePath.relative(repoRoot, catalog)}.`);
