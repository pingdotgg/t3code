// The native markdown renderer draws a link's icon from a raster image, so each source control
// host's mark is rendered from its definition's artwork into a bundled PNG.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  sourceControlClients,
  type SourceControlIcon,
} from "@t3tools/client-runtime/source-control-clients";

const appDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = NodePath.join(appDirectory, "assets/link-icons");
const generatedModulePath = NodePath.join(appDirectory, "src/lib/markdownLinkIcons.generated.ts");
const sharp = NodeModule.createRequire(
  NodePath.resolve(appDirectory, "../../scripts/package.json"),
)("sharp");

const SIZE = 64;

function attribute(name: string, value: string | number | undefined): string {
  return value === undefined ? "" : ` ${name}="${value}"`;
}

// A monochrome mark is tinted by the renderer, which only reads its alpha.
function svgMarkup(icon: SourceControlIcon): string {
  const paint = (value: SourceControlIcon["paths"][number]["fill"]) =>
    value === undefined
      ? "none"
      : typeof value === "string"
        ? value.replace("currentColor", "#ffffff")
        : `url(#${value.gradient})`;
  const gradients = (icon.gradients ?? [])
    .map(
      (gradient) =>
        `<linearGradient id="${gradient.id}" x1="${gradient.x1}" y1="${gradient.y1}" x2="${gradient.x2}" y2="${gradient.y2}" gradientUnits="userSpaceOnUse"${attribute("gradientTransform", gradient.transform)}>${gradient.stops
          .map(
            (stop) =>
              `<stop offset="${stop.offset}" stop-color="${stop.color}"${attribute("stop-opacity", stop.opacity)}/>`,
          )
          .join("")}</linearGradient>`,
    )
    .join("");
  const paths = icon.paths
    .map(
      (path) =>
        `<path d="${path.d}" fill="${paint(path.fill)}"${attribute("fill-rule", path.fillRule)}${attribute("fill-opacity", path.fillOpacity)}${attribute("stroke", path.stroke === undefined ? undefined : paint(path.stroke))}${attribute("stroke-width", path.strokeWidth)}/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${icon.viewBox}" fill="none"><defs>${gradients}</defs>${paths}</svg>`;
}

NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
NodeFS.mkdirSync(outputDirectory, { recursive: true });

const kinds: string[] = [];
for (const definition of sourceControlClients.definitions) {
  if (definition.icon === null) continue;
  await sharp(Buffer.from(svgMarkup(definition.icon)), { density: 72 * 4 })
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(NodePath.join(outputDirectory, `${definition.kind}.png`));
  kinds.push(definition.kind);
}

NodeFS.writeFileSync(
  generatedModulePath,
  `import type { ImageSourcePropType } from "react-native";\n\nexport const SOURCE_CONTROL_LINK_ICON_SOURCES: Readonly<Record<string, ImageSourcePropType>> = {\n${kinds
    .toSorted()
    .map(
      (kind) =>
        `  ${/^\w+$/u.test(kind) ? kind : `"${kind}"`}: require("../../assets/link-icons/${kind}.png"),`,
    )
    .join("\n")}\n};\n`,
);
