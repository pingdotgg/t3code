// Regenerates resources/images/providers/*-{black,white}.png from the canonical provider logos.
// Geometry is read from the same sources the web app draws, so the watch never carries a redrawn
// substitute. Run from apps/t3-pebble with NODE_PATH pointing at the scripts package's sharp:
//   NODE_PATH=../../scripts/node_modules bun scripts/generate-provider-icons.ts
import * as NodeFSP from "node:fs/promises";
import sharp from "sharp";

const SIZE = 14;
const RENDER = SIZE * 4;
const ROOT = new URL("../../../", import.meta.url);
const OUT = new URL("../resources/images/providers/", import.meta.url);
const INK = { black: { r: 0, g: 0, b: 0 }, white: { r: 255, g: 255, b: 255 } };

type Path = { d: string; fill?: string; fillRule?: string };
type Logo = { viewBox: string; paths: Path[] } | { png: Buffer };

const read = (path: string) => NodeFSP.readFile(new URL(path, ROOT), "utf8");

async function webIcons() {
  const source = await read("apps/web/src/components/Icons.tsx");
  const pathAfter = (marker: string) => {
    const start = source.indexOf(marker);
    const match = start < 0 ? null : /d="([^"]+)"/.exec(source.slice(start));
    if (!match) throw new Error(`${marker} path not found in Icons.tsx`);
    return match[1];
  };
  const dataUrl = /ANTIGRAVITY_ICON_DATA_URL\s*=\s*\n?\s*"([^"]+)"/.exec(source);
  if (!dataUrl) throw new Error("ANTIGRAVITY_ICON_DATA_URL not found in Icons.tsx");
  return {
    codex: {
      viewBox: "100 100 411 411",
      paths: [{ d: pathAfter("export const OpenAI"), fillRule: "evenodd" }],
    } as Logo,
    claude: {
      viewBox: "0 0 256 257",
      paths: [{ d: pathAfter("export const ClaudeAI") }],
    } as Logo,
    antigravity: {
      png: Buffer.from(dataUrl[1].replace(/^data:image\/png;base64,/, ""), "base64"),
    } as Logo,
  };
}

async function packageIcons() {
  const parse = (source: string, name: string): Logo => {
    const block = source.slice(source.indexOf("icon: {"));
    const viewBox = /viewBox:\s*"([^"]+)"/.exec(block)?.[1];
    const paths = [...block.matchAll(/\{\s*d:\s*"([^"]+)"([^}]*)\}/g)].map((match) => ({
      d: match[1],
      fill: /fill:\s*(?:\{\s*light:\s*)?"([^"]+)"/.exec(match[2])?.[1],
      fillRule: /fillRule:\s*"([^"]+)"/.exec(match[2])?.[1],
    }));
    if (!viewBox || !paths.length) throw new Error(`${name} icon not found`);
    return { viewBox, paths };
  };
  const files = { cursor: "cursor", grok: "grok", opencode: "opencode" } as const;
  const logos: Record<string, Logo> = {};
  for (const [id, dir] of Object.entries(files)) {
    logos[id] = parse(await read(`packages/provider-${dir}/src/client.ts`), id);
  }
  // Kiro composes its icon from named path constants, so resolve them before rendering.
  const kiro = await read("packages/provider-kiro/src/client.ts");
  const constant = (name: string) => {
    const match = new RegExp(`const ${name} =\\s*"([^"]+)"`).exec(kiro);
    if (!match) throw new Error(`kiro ${name} not found`);
    return match[1];
  };
  const [tile, ghost, leftEye, rightEye] = ["TILE", "GHOST", "LEFT_EYE", "RIGHT_EYE"].map(constant);
  logos.kiro = {
    viewBox: "0 0 1200 1200",
    paths: [
      { d: `${tile}${ghost}${leftEye}${rightEye}`, fillRule: "evenodd" },
      { d: ghost, fill: "#ffffff" },
      { d: leftEye, fill: "#000000" },
      { d: rightEye, fill: "#000000" },
    ],
  };
  return logos;
}

// Paths that paint the light "negative space" of a logo are dropped so the shape reads as a stencil.
const isLight = (fill: string) => {
  const hex = fill.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.55;
};

function svg(logo: { viewBox: string; paths: Path[] }) {
  const body = logo.paths
    .filter((path) => !path.fill || !isLight(path.fill))
    .map(
      (path) =>
        `<path d="${path.d}" fill="#000"${path.fillRule ? ` fill-rule="${path.fillRule}"` : ""}/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${logo.viewBox}" width="${RENDER}" height="${RENDER}">${body}</svg>`;
}

async function alphaMask(logo: Logo) {
  const image = "png" in logo ? sharp(logo.png) : sharp(Buffer.from(svg(logo)));
  const { data, info } = await image
    .resize(SIZE, SIZE, { fit: "contain" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Opaque raster art (Antigravity ships a PNG) has no usable alpha, so key out its light pixels.
  const keyed = "png" in logo && !(await sharp(logo.png).metadata()).hasAlpha;
  const alpha = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < alpha.length; i++) {
    const offset = i * info.channels;
    const [r, g, b, a] = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
    alpha[i] = keyed ? 255 - (r + g + b) / 3 : a;
  }
  return alpha;
}

async function tint(alpha: Uint8Array, ink: { r: number; g: number; b: number }) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < alpha.length; i++) {
    rgba[i * 4] = ink.r;
    rgba[i * 4 + 1] = ink.g;
    rgba[i * 4 + 2] = ink.b;
    rgba[i * 4 + 3] = alpha[i];
  }
  return sharp(rgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png()
    .toBuffer();
}

const logos = { ...(await webIcons()), ...(await packageIcons()) };
await NodeFSP.mkdir(OUT, { recursive: true });
for (const [id, logo] of Object.entries(logos)) {
  const alpha = await alphaMask(logo as Logo);
  for (const [name, ink] of Object.entries(INK)) {
    const file = new URL(`${id}-${name}.png`, OUT);
    await sharp(await tint(alpha, ink)).toFile(file.pathname);
    console.log(`${file.pathname.split("/resources/")[1]}`);
  }
}
