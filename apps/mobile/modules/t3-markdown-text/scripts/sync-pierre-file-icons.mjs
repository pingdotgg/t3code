import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getBuiltInSpriteSheet } from "@pierre/trees";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const moduleDirectory = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(moduleDirectory, "../../../..");
const outputDirectory = join(moduleDirectory, "assets/file-icons");
const generatedModulePath = join(moduleDirectory, "src/markdownFileIcons.generated.ts");
const webIconSource = readFileSync(join(repositoryRoot, "apps/web/src/pierre-icons.ts"), "utf8");
const customSprite = webIconSource.match(/const T3_FILE_ICON_SPRITE = `([\s\S]*?)`;/)?.[1];

if (!customSprite) {
  throw new Error("Could not read the T3 Pierre icon sprite from apps/web/src/pierre-icons.ts");
}

const colors = {
  astro: "#a631be",
  babel: "#d5a910",
  bash: "#199f43",
  biome: "#1a85d4",
  bootstrap: "#693acf",
  browserslist: "#d5a910",
  bun: "#594c5b",
  c: "#1a85d4",
  claude: "#d47628",
  cpp: "#1a85d4",
  css: "#693acf",
  database: "#a631be",
  default: "#84848a",
  docker: "#1a85d4",
  eslint: "#693acf",
  font: "#84848a",
  git: "#ff8c5b",
  go: "#1ca1c7",
  graphql: "#d32a61",
  html: "#d47628",
  image: "#d32a61",
  javascript: "#d5a910",
  json: "#d47628",
  markdown: "#199f43",
  mcp: "#17a5af",
  nextjs: "#84848a",
  npm: "#d52c36",
  oxc: "#1ca1c7",
  postcss: "#d52c36",
  prettier: "#17a5af",
  python: "#1a85d4",
  react: "#1ca1c7",
  ruby: "#d52c36",
  rust: "#d47628",
  sass: "#d32a61",
  stylelint: "#84848a",
  svelte: "#d52c36",
  svg: "#d47628",
  svgo: "#199f43",
  swift: "#d47628",
  table: "#17a5af",
  tailwind: "#1ca1c7",
  terraform: "#693acf",
  text: "#84848a",
  typescript: "#1a85d4",
  vite: "#a631be",
  vscode: "#1a85d4",
  vue: "#199f43",
  wasm: "#693acf",
  webpack: "#1a85d4",
  yml: "#d52c36",
  zig: "#d47628",
  zip: "#d47628",
};

const customIcons = {
  agents: "t3-file-icon-agents",
  claude: "t3-file-icon-claude",
  package: "t3-file-icon-package-json",
  pnpm: "t3-file-icon-pnpm",
  readme: "t3-file-icon-readme",
  tsconfig: "t3-file-icon-tsconfig",
};

function symbolFromSprite(sprite, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sprite.match(
    new RegExp(`<symbol id="${escapedId}"([^>]*)>([\\s\\S]*?)<\\/symbol>`),
  );
  if (!match) throw new Error(`Missing Pierre icon symbol: ${id}`);
  return {
    body: match[2],
    viewBox: match[1].match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 16 16",
  };
}

function renderIcon(token, symbol, color) {
  const svgPath = join(outputDirectory, `.pierre-${token}.svg`);
  const pngPath = join(outputDirectory, `pierre_${token}.png`);
  writeFileSync(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${symbol.viewBox}" style="color:${color}">${symbol.body}</svg>`,
  );
  execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
    stdio: "ignore",
  });
  rmSync(svgPath);
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const builtInSprite = getBuiltInSpriteSheet("complete");
const builtInTokens = [...builtInSprite.matchAll(/<symbol id="file-tree-builtin-([^"]+)"/g)]
  .map((match) => match[1])
  .sort();

for (const token of builtInTokens) {
  renderIcon(
    token,
    symbolFromSprite(builtInSprite, `file-tree-builtin-${token}`),
    colors[token] ?? colors.default,
  );
}
for (const [token, symbolId] of Object.entries(customIcons)) {
  renderIcon(token, symbolFromSprite(customSprite, symbolId), colors[token] ?? colors.default);
}

const tokens = [...new Set([...builtInTokens, ...Object.keys(customIcons)])].sort();
const generatedSource = `import type { ImageSourcePropType } from "react-native";\n\nexport const MARKDOWN_FILE_ICON_SOURCES = {\n${tokens
  .map((token) => `  ${token}: require("../assets/file-icons/pierre_${token}.png"),`)
  .join("\n")}\n} as const satisfies Readonly<Record<string, ImageSourcePropType>>;\n`;
writeFileSync(generatedModulePath, generatedSource);
