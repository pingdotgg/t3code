import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Alias, type Plugin } from "vite";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required preview harness env var: ${name}`);
  }
  return value;
}

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

const runtimeRoot = requireEnv("FORMA_PREVIEW_RUNTIME_ROOT");
const projectRoot = requireEnv("FORMA_PREVIEW_PROJECT_ROOT");
const workspaceRoot = process.env.FORMA_PREVIEW_WORKSPACE_ROOT?.trim() || projectRoot;
const host = process.env.FORMA_PREVIEW_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.FORMA_PREVIEW_PORT ?? "0");
const framework = process.env.FORMA_PREVIEW_FRAMEWORK?.trim() || "unsupported";
const moduleMocks = parseJsonEnv<Record<string, string>>("FORMA_PREVIEW_MODULE_MOCKS", {});
const cacheDir =
  process.env.FORMA_PREVIEW_CACHE_DIR?.trim() || path.join(runtimeRoot, "node_modules", ".vite");
const optimizeDepsEntries = parseJsonEnv<string[]>("FORMA_PREVIEW_OPTIMIZE_DEPS_ENTRIES", [
  "src/main.tsx",
]);
const warmupFiles = parseJsonEnv<string[]>("FORMA_PREVIEW_WARMUP_FILES", []);
const extraAliases = parseJsonEnv<Array<{ find: string; replacement: string }>>(
  "FORMA_PREVIEW_ALIASES",
  [],
);

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const reactAliases = parseJsonEnv<Record<string, string>>("FORMA_PREVIEW_REACT_ALIASES", {});
const workspacePublicDir = path.join(workspaceRoot, "public");
const workspaceRequire = createRequire(path.join(workspaceRoot, "package.json"));
const projectRequire = createRequire(path.join(projectRoot, "package.json"));

function cssString(value: string): string {
  return JSON.stringify(value);
}

function isBareImport(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("\0") &&
    !/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/\/)/.test(specifier)
  );
}

function tryResolveFromRequire(requireFromRoot: NodeJS.Require, specifier: string): string | null {
  try {
    return requireFromRoot.resolve(specifier);
  } catch {
    return null;
  }
}

function workspaceBareImportResolver(): Plugin {
  return {
    name: "forma-workspace-bare-import-resolver",
    async resolveId(source) {
      if (!isBareImport(source)) {
        return null;
      }
      return (
        tryResolveFromRequire(workspaceRequire, source) ??
        tryResolveFromRequire(projectRequire, source)
      );
    },
  };
}

function tailwindSourceInjector(): Plugin {
  const sourceRoots = [
    workspaceRoot,
    path.join(projectRoot, ".forma", "preview"),
    path.join(projectRoot, "packages"),
  ].filter(
    (sourceRoot, index, roots) => existsSync(sourceRoot) && roots.indexOf(sourceRoot) === index,
  );
  const sourceDirectives = sourceRoots.map((sourceRoot) => `@source ${cssString(sourceRoot)};`);

  return {
    name: "forma-tailwind-source-injector",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".css") || !/@import\s+["']tailwindcss["']\s*;/.test(code)) {
        return null;
      }
      if (sourceDirectives.length === 0) {
        return null;
      }
      return code.replace(
        /@import\s+["']tailwindcss["']\s*;/,
        (match) => `${match}\n${sourceDirectives.join("\n")}`,
      );
    },
  };
}

function compareAliasPrecedence(left: Alias, right: Alias) {
  const leftFind = left.find;
  const rightFind = right.find;

  if (typeof leftFind === "string" && typeof rightFind === "string") {
    return rightFind.length - leftFind.length;
  }
  if (typeof leftFind === "string") {
    return -1;
  }
  if (typeof rightFind === "string") {
    return 1;
  }
  return 0;
}

const aliasEntries: Alias[] = [
  ...Object.entries(moduleMocks).map(([find, replacement]) => ({ find, replacement })),
  ...(framework === "react-next"
    ? [
        {
          find: "next/navigation",
          replacement: path.join(harnessDir, "nextNavigationShim.ts"),
        },
        {
          find: "next/link",
          replacement: path.join(harnessDir, "nextLinkShim.tsx"),
        },
        {
          find: "next/image",
          replacement: path.join(harnessDir, "nextImageShim.tsx"),
        },
      ]
    : []),
  ...extraAliases,
  ...Object.entries(reactAliases).map(([find, replacement]) => ({ find, replacement })),
].toSorted(compareAliasPrecedence);

export default defineConfig({
  appType: "spa",
  root: runtimeRoot,
  cacheDir,
  publicDir: existsSync(workspacePublicDir) ? workspacePublicDir : false,
  plugins: [workspaceBareImportResolver(), tailwindSourceInjector(), react(), tailwindcss()],
  css: {
    postcss: workspaceRoot,
  },
  resolve: {
    alias: aliasEntries,
  },
  optimizeDeps: {
    entries: optimizeDepsEntries,
    holdUntilCrawlEnd: true,
    ignoreOutdatedRequests: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    headers: {
      "Cache-Control": "no-store",
    },
    warmup: {
      clientFiles: warmupFiles,
    },
    fs: {
      allow: [runtimeRoot, projectRoot, workspaceRoot, harnessDir],
    },
  },
});
