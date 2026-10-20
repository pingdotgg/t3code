import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const appDirectory = NodePath.resolve(scriptDirectory, "..");
const repositoryRoot = NodePath.resolve(appDirectory, "../..");
const outputDirectory = NodePath.join(appDirectory, "assets/context-chip-icons");
const generatedModulePath = NodePath.join(appDirectory, "src/lib/contextChipIcons.generated.ts");

const requireFromWeb = NodeModule.createRequire(
  NodePath.join(repositoryRoot, "apps/web/package.json"),
);
const requireFromScripts = NodeModule.createRequire(
  NodePath.join(repositoryRoot, "scripts/package.json"),
);
const sharp = requireFromScripts("sharp");
const lucideIconsDirectory = NodePath.join(
  NodePath.dirname(requireFromWeb.resolve("lucide-react/package.json")),
  "dist/esm/icons",
);
const webChipSource = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "apps/web/src/components/composerInlineChip.ts"),
  "utf8",
);
const skillSvg = webChipSource.match(/SKILL_CHIP_ICON_SVG = `([\s\S]*?)`;/)?.[1];

if (!skillSvg) {
  throw new Error(
    "Could not read SKILL_CHIP_ICON_SVG from apps/web/src/components/composerInlineChip.ts",
  );
}

const lucideIcons = [
  "circle-dashed",
  "film",
  "git-merge",
  "git-pull-request-arrow",
  "git-pull-request-closed",
  "git-pull-request-draft",
  "image",
  "message-circle",
  "messages-square",
  "mouse-pointer-click",
  "terminal",
];

async function lucideSvg(name) {
  const module = await import(
    NodeURL.pathToFileURL(NodePath.join(lucideIconsDirectory, `${name}.js`)).href
  );
  const body = module.__iconNode
    .map(([tag, { key: _key, ...attributes }]) => {
      const attributeText = Object.entries(attributes)
        .map(([attribute, value]) => `${attribute}="${value}"`)
        .join(" ");
      return `<${tag} ${attributeText}/>`;
    })
    .join("");
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

async function renderIcon(token, svg) {
  const sized = svg
    .replace(/^<svg[^>]*?>/, (tag) =>
      tag
        .replace(/ (?:width|height)="[^"]*"/g, "")
        .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" '),
    )
    .replaceAll("currentColor", "#ffffff");
  await sharp(Buffer.from(sized), { density: 72 * (64 / 24) })
    .resize(64, 64)
    .png()
    .toFile(NodePath.join(outputDirectory, `${token}.png`));
}

NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
NodeFS.mkdirSync(outputDirectory, { recursive: true });

for (const name of lucideIcons) {
  await renderIcon(name, await lucideSvg(name));
}
await renderIcon("skill", skillSvg);

const tokens = [...lucideIcons, "skill"].sort();
const generatedSource = `import type { ImageSourcePropType } from "react-native";\n\nexport const CONTEXT_CHIP_ICON_SOURCES = {\n${tokens
  .map(
    (token) =>
      `  ${/^\w+$/.test(token) ? token : `"${token}"`}: require("../../assets/context-chip-icons/${token}.png"),`,
  )
  .join("\n")}\n} as const satisfies Readonly<Record<string, ImageSourcePropType>>;\n`;
NodeFS.writeFileSync(generatedModulePath, generatedSource);
