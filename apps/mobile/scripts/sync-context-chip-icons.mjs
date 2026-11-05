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
  "bot",
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
  "server",
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

// Provider logos, so a model chip can show what the model menu shows. Native chips take images,
// not SVG. Logos that swap between black and white per theme are tinted with the chip's accent.
const mobileProviderIcon = NodeFS.readFileSync(
  NodePath.join(appDirectory, "src/components/ProviderIcon.tsx"),
  "utf8",
);
function bundledPath(viewBox) {
  const path = mobileProviderIcon
    .slice(mobileProviderIcon.indexOf(`viewBox="${viewBox}"`))
    .match(/\bd="([^"]+)"/)?.[1];
  if (!path) throw new Error(`Could not read the ${viewBox} logo from ProviderIcon.tsx`);
  return path;
}
const packageClients = await Promise.all(
  ["cursor", "fx", "grok", "kiro", "muse", "opencode", "pi"].map(async (name) => {
    const module = await import(
      NodeURL.pathToFileURL(
        NodePath.join(repositoryRoot, `packages/provider-${name}/src/client.ts`),
      ).href
    );
    const client = Object.values(module).find((value) => value?.icon && value?.driverKind);
    if (!client) throw new Error(`packages/provider-${name} exports no client with an icon`);
    return client;
  }),
);
const providerSvg = (viewBox, paths) =>
  `<svg viewBox="${viewBox}" fill="none">${paths
    .map(
      (path) =>
        `<path d="${path.d}" fill="${path.fill}" fill-opacity="${path.opacity ?? 1}"${
          path.fillRule ? ` fill-rule="${path.fillRule}" clip-rule="${path.fillRule}"` : ""
        }/>`,
    )
    .join("")}</svg>`;
const providerLogos = [
  {
    driverKind: "codex",
    tintsIcon: true,
    svg: providerSvg("100 100 411 411", [
      { d: bundledPath("100 100 411 411"), fill: "#ffffff", fillRule: "evenodd" },
    ]),
  },
  {
    driverKind: "claudeAgent",
    tintsIcon: false,
    svg: providerSvg("0 0 256 257", [{ d: bundledPath("0 0 256 257"), fill: "#D97757" }]),
  },
  ...packageClients.map(({ driverKind, icon }) => {
    const tintsIcon = icon.fill.light !== icon.fill.dark;
    return {
      driverKind,
      tintsIcon,
      svg: providerSvg(
        icon.viewBox,
        icon.paths.map((path) => ({
          d: path.d,
          fillRule: path.fillRule,
          fill: tintsIcon ? "#ffffff" : (path.fill ?? icon.fill).light,
          // A tint flattens color, so a logo's secondary shapes keep their contrast through alpha.
          ...(tintsIcon && path.fill ? { opacity: 0.4 } : {}),
        })),
      ),
    };
  }),
];
for (const { driverKind, svg } of providerLogos) {
  await renderIcon(`provider-${driverKind}`, svg);
}

const tokens = [...lucideIcons, "skill"].sort();
const generatedSource = `import type { ImageSourcePropType } from "react-native";\n\nexport const CONTEXT_CHIP_ICON_SOURCES = {\n${tokens
  .map(
    (token) =>
      `  ${/^\w+$/.test(token) ? token : `"${token}"`}: require("../../assets/context-chip-icons/${token}.png"),`,
  )
  .join("\n")}\n} as const satisfies Readonly<Record<string, ImageSourcePropType>>;\n`;
const providerSource = `\nexport const PROVIDER_CHIP_ICONS: Readonly<\n  Record<string, { readonly source: ImageSourcePropType; readonly tintsIcon: boolean }>\n> = {\n${providerLogos
  .toSorted((left, right) => left.driverKind.localeCompare(right.driverKind))
  .map(
    ({ driverKind, tintsIcon }) =>
      `  ${driverKind}: {\n    source: require("../../assets/context-chip-icons/provider-${driverKind}.png"),\n    tintsIcon: ${tintsIcon},\n  },`,
  )
  .join(
    "\n",
  )}\n  antigravity: { source: require("../../assets/antigravity.png"), tintsIcon: false },\n};\n`;
NodeFS.writeFileSync(generatedModulePath, generatedSource + providerSource);
