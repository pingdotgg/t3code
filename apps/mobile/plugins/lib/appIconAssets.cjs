const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const catalog = require("../../assets/app-icons/catalog.json");

const iconName = (id) => `T3Icon_${id.replaceAll("-", "_")}`;

/** Derive iOS variants from the production Icon Composer project, preserving its layers and effects. */
async function writeIosIconProject(projectRoot, id, destination) {
  const icon = catalog[id];
  if (!icon) throw new Error(`Unknown app icon: ${id}`);
  const source = path.resolve(projectRoot, "../../assets/prod/app-icon.icon");
  await fs.cp(source, destination, { recursive: true });
  if (id === "t3-code") return;
  const documentPath = path.join(destination, "icon.json");
  const document = JSON.parse(await fs.readFile(documentPath, "utf8"));
  const color = icon.top
    .slice(1)
    .match(/../g)
    .map((channel) => (parseInt(channel, 16) / 255).toFixed(5))
    .join(",");
  document.fill = { "automatic-gradient": `srgb:${color},1.00000` };
  await fs.writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
}

// The approved Field artwork uses the existing T3 vector, never a font approximation.
async function renderAppIcon(projectRoot, id, layer = "complete") {
  const icon = catalog[id];
  if (!icon) throw new Error(`Unknown app icon: ${id}`);
  const source = await fs.readFile(
    path.resolve(projectRoot, "../../assets/prod/app-icon.icon/Assets/text.svg"),
    "utf8",
  );
  const mark = source.match(/<path[\s\S]*?\sd="([^"]+)"/)[1];
  const glyph = (y, fill) =>
    `<svg x="22" y="${y}" width="56" height="33.8" viewBox="15.53 37 94.5 57"><path d="${mark}" fill="${fill}"/></svg>`;
  const foreground = `${icon.shadow ? glyph(33.9, icon.shadow) : ""}${glyph(33.1, icon.mark)}`;
  const background = `<rect width="100" height="100" fill="url(#field)"/><rect width="100" height="100" fill="url(#light)"/><path d="M0 0H100V24Q52 13 0 38Z" fill="url(#gloss)"/>`;
  // Android owns the outer mask. Its foreground has a 108dp viewport with the
  // approved 100-unit composition scaled into the central 72dp visible area.
  const body =
    layer === "foreground"
      ? `<g transform="translate(18 18) scale(.72)">${foreground}</g>`
      : layer === "background"
        ? background
        : `${background}<rect x=".75" y=".75" width="98.5" height="98.5" rx="21.6" fill="none" stroke="url(#edge)" stroke-width="1.5"/>${foreground}`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 ${layer === "foreground" ? 108 : 100} ${layer === "foreground" ? 108 : 100}"><defs>
<linearGradient id="field" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${icon.top}"/><stop offset="1" stop-color="${icon.bottom}"/></linearGradient>
<radialGradient id="light" cx=".22" cy=".08" r=".95"><stop stop-color="#fff" stop-opacity=".22"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".09"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".42"/><stop offset=".35" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>${body}</svg>`);
}

async function writeIconPng(projectRoot, id, destination, size, layer = "complete") {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const output = sharp(await renderAppIcon(projectRoot, id, layer)).resize(size, size);
  // App Store icons must not contain an alpha channel, even when every pixel is opaque.
  if (layer !== "foreground") output.removeAlpha();
  await output.png().toFile(destination);
}

module.exports = { catalog, iconName, renderAppIcon, writeIconPng, writeIosIconProject };
