import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Alias } from "vite";

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
const extraAliases = parseJsonEnv<Array<{ find: string; replacement: string }>>(
  "FORMA_PREVIEW_ALIASES",
  [],
);

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const reactAliases = parseJsonEnv<Record<string, string>>("FORMA_PREVIEW_REACT_ALIASES", {});
const workspacePublicDir = path.join(workspaceRoot, "public");

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
  publicDir: existsSync(workspacePublicDir) ? workspacePublicDir : false,
  plugins: [react()],
  css: {
    postcss: workspaceRoot,
  },
  resolve: {
    alias: aliasEntries,
  },
  server: {
    host,
    port,
    strictPort: true,
    fs: {
      allow: [runtimeRoot, projectRoot, workspaceRoot, harnessDir],
    },
  },
});
