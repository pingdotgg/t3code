import type { MARKDOWN_FILE_ICON_SOURCES } from "./markdownFileIcons.generated";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

export type MarkdownLinkPresentation =
  | {
      readonly kind: "external";
      readonly href: string;
      readonly host: string;
    }
  | {
      readonly kind: "file";
      readonly icon: MarkdownFileIcon;
      readonly label: string;
    }
  | {
      readonly kind: "link";
      readonly href: string | null;
    };

export type MarkdownFileIcon = keyof typeof MARKDOWN_FILE_ICON_SOURCES;

const FILE_ICON_BY_NAME: Readonly<Record<string, MarkdownFileIcon>> = {
  ".babelrc": "babel",
  ".babelrc.json": "babel",
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".browserslistrc": "browserslist",
  ".dockerignore": "docker",
  ".eslintignore": "eslint",
  ".eslintrc": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.yaml": "eslint",
  ".eslintrc.yml": "eslint",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  ".oxlintrc.json": "oxc",
  ".postcssrc": "postcss",
  ".postcssrc.json": "postcss",
  ".postcssrc.yaml": "postcss",
  ".postcssrc.yml": "postcss",
  ".prettierignore": "prettier",
  ".prettierrc": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.toml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierrc.yml": "prettier",
  ".stylelintignore": "stylelint",
  ".stylelintrc": "stylelint",
  ".stylelintrc.cjs": "stylelint",
  ".stylelintrc.js": "stylelint",
  ".stylelintrc.json": "stylelint",
  ".stylelintrc.mjs": "stylelint",
  ".stylelintrc.yaml": "stylelint",
  ".stylelintrc.yml": "stylelint",
  ".terraform.lock.hcl": "terraform",
  ".zprofile": "bash",
  ".zshenv": "bash",
  ".zshrc": "bash",
  "agents.md": "agents",
  "babel.config.js": "babel",
  "babel.config.cjs": "babel",
  "babel.config.json": "babel",
  "babel.config.mjs": "babel",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "bunfig.toml": "bun",
  "claude.md": "claude",
  "compose.yaml": "docker",
  "compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.override.yml": "docker",
  dockerfile: "docker",
  "eslint.config.js": "eslint",
  "eslint.config.cjs": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.mts": "eslint",
  "eslint.config.ts": "eslint",
  gemfile: "ruby",
  "next.config.js": "nextjs",
  "next.config.mjs": "nextjs",
  "next.config.mts": "nextjs",
  "next.config.ts": "nextjs",
  "package.json": "package",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "postcss.config.js": "postcss",
  "postcss.config.cjs": "postcss",
  "postcss.config.mjs": "postcss",
  "postcss.config.ts": "postcss",
  "prettier.config.js": "prettier",
  "prettier.config.cjs": "prettier",
  "prettier.config.mjs": "prettier",
  rakefile: "ruby",
  "readme.md": "readme",
  "stylelint.config.js": "stylelint",
  "stylelint.config.cjs": "stylelint",
  "stylelint.config.mjs": "stylelint",
  "svgo.config.js": "svgo",
  "svgo.config.cjs": "svgo",
  "svgo.config.mjs": "svgo",
  "svgo.config.ts": "svgo",
  "tailwind.config.js": "tailwind",
  "tailwind.config.cjs": "tailwind",
  "tailwind.config.mjs": "tailwind",
  "tailwind.config.ts": "tailwind",
  "tsconfig.json": "tsconfig",
  "vite.config.js": "vite",
  "vite.config.mjs": "vite",
  "vite.config.mts": "vite",
  "vite.config.ts": "vite",
  "webpack.config.js": "webpack",
  "webpack.config.babel.js": "webpack",
  "webpack.config.cjs": "webpack",
  "webpack.config.mjs": "webpack",
  "webpack.config.ts": "webpack",
};

const FILE_ICON_BY_EXTENSION: Readonly<Record<string, MarkdownFileIcon>> = {
  "7z": "zip",
  astro: "astro",
  avif: "image",
  "code-workspace": "vscode",
  bash: "bash",
  bmp: "image",
  bz2: "zip",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  css: "css",
  csv: "table",
  cts: "typescript",
  db: "database",
  env: "text",
  "env.development": "text",
  "env.local": "text",
  "env.production": "text",
  eot: "font",
  erb: "ruby",
  fish: "bash",
  gif: "image",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  gz: "zip",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  htm: "html",
  html: "html",
  ico: "image",
  icns: "image",
  ini: "text",
  inl: "cpp",
  jar: "zip",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsx: "react",
  json: "json",
  jsonc: "json",
  less: "css",
  md: "markdown",
  mdx: "markdown",
  "mdx.tsx": "markdown",
  mjs: "javascript",
  mts: "typescript",
  png: "image",
  postcss: "css",
  py: "python",
  pyi: "python",
  pyw: "python",
  pyx: "python",
  rake: "ruby",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scss: "sass",
  sh: "bash",
  sql: "database",
  sqlite: "database",
  sqlite3: "database",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  tf: "terraform",
  tfstate: "terraform",
  tfvars: "terraform",
  tgz: "zip",
  ts: "typescript",
  tsv: "table",
  tsx: "react",
  txt: "text",
  woff: "font",
  woff2: "font",
  vue: "vue",
  wasm: "wasm",
  webp: "image",
  yml: "yml",
  yaml: "yml",
  zig: "zig",
  zip: "zip",
  zsh: "bash",
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

function fileUrlPath(href: string): string | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") {
      return null;
    }
    const path = /^\/[A-Za-z]:[\\/]/.test(parsed.pathname)
      ? parsed.pathname.slice(1)
      : parsed.pathname;
    const lineMatch = parsed.hash.match(/^#L(\d+)(?:C(\d+))?$/i);
    return `${safeDecode(path)}${
      lineMatch?.[1] ? `:${lineMatch[1]}${lineMatch[2] ? `:${lineMatch[2]}` : ""}` : ""
    }`;
  } catch {
    return null;
  }
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) {
    return false;
  }
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if (POSITION_SUFFIX_PATTERN.test(path)) {
    return true;
  }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function looksLikeFilePath(value: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value)) {
    return true;
  }
  if (RELATIVE_PATH_PREFIX_PATTERN.test(value)) {
    return true;
  }
  if (value.startsWith("/")) {
    return looksLikePosixFilesystemPath(value);
  }
  if (FILE_ICON_BY_NAME[value.replace(POSITION_SUFFIX_PATTERN, "").toLowerCase()]) {
    return true;
  }
  return RELATIVE_FILE_PATH_PATTERN.test(value) || RELATIVE_FILE_NAME_PATTERN.test(value);
}

function fileLabel(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename || normalized;
}

export function resolveMarkdownFileIcon(value: string): MarkdownFileIcon {
  const basename = fileLabel(value).replace(POSITION_SUFFIX_PATTERN, "").toLowerCase();
  const exactIcon = FILE_ICON_BY_NAME[basename];
  if (exactIcon) return exactIcon;
  if (basename.startsWith("tsconfig.") && basename.endsWith(".json")) {
    return "tsconfig";
  }
  const segments = basename.split(".");
  for (let index = 1; index < segments.length; index += 1) {
    const icon = FILE_ICON_BY_EXTENSION[segments.slice(index).join(".")];
    if (icon) return icon;
  }
  return "default";
}

export function resolveMarkdownLinkPresentation(href: string): MarkdownLinkPresentation {
  const normalized = normalizeDestination(href);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return {
        kind: "external",
        href: parsed.toString(),
        host: parsed.hostname,
      };
    }
  } catch {
    // Relative paths and non-URL link destinations are handled below.
  }

  const fileTarget = normalized.toLowerCase().startsWith("file:")
    ? fileUrlPath(normalized)
    : safeDecode(normalized.split(/[?#]/, 1)[0] ?? normalized);
  if (fileTarget && looksLikeFilePath(fileTarget)) {
    return {
      kind: "file",
      icon: resolveMarkdownFileIcon(fileTarget),
      label: fileLabel(fileTarget),
    };
  }

  return {
    kind: "link",
    href: /^(?:mailto|tel):/i.test(normalized) ? normalized : null,
  };
}
