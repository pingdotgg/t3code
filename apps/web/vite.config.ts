import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import {
  clientConfigurationFingerprint,
  clientSourceFingerprint,
} from "../../scripts/lib/client-build.ts";
import { fileURLToPath } from "node:url";
import { createDevProxyConfig, resolveDevProxyTarget } from "./src/vite/devProxy.ts";

const repoEnv = loadRepoEnv();
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const buildEnvironment = { ...process.env };
const configurationFingerprint = clientConfigurationFingerprint(repoRoot, buildEnvironment);
let sourceFingerprint: string;
Object.assign(process.env, repoEnv);

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const isSingleOriginDev = process.env.T3CODE_SINGLE_ORIGIN_DEV === "1";
const configuredHttpUrl = isSingleOriginDev ? undefined : process.env.VITE_HTTP_URL?.trim();
const configuredWsUrl = isSingleOriginDev ? undefined : process.env.VITE_WS_URL?.trim();
const configuredClerkPublishableKey = repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim();
const configuredCliOAuthClientId = repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID?.trim();
const configuredHostedAppUrl = repoEnv.VITE_HOSTED_APP_URL?.trim();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const devProxyTarget = resolveDevProxyTarget(process.env.T3CODE_PORT, configuredWsUrl);
const devProxyConfig = createDevProxyConfig(devProxyTarget);
const configuredAllowedHosts = (process.env.T3CODE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig({
  plugins: [
    {
      name: "t3-client-build-stamp",
      apply: "build",
      buildStart() {
        sourceFingerprint = clientSourceFingerprint(repoRoot);
      },
      generateBundle() {
        if (
          clientSourceFingerprint(repoRoot) !== sourceFingerprint ||
          clientConfigurationFingerprint(repoRoot, buildEnvironment) !== configurationFingerprint
        ) {
          throw new Error(
            "Web sources or configuration changed during the build. Rerun pnpm build.",
          );
        }
        this.emitFile({
          type: "asset",
          fileName: ".t3-build.json",
          source: JSON.stringify({
            version: 2,
            fingerprint: sourceFingerprint,
            configuration: configurationFingerprint,
          }),
        });
      },
    },
    tanstackRouter(),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: [
      "@base-ui/react/context-menu",
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "effect/Array",
      "effect/Order",
    ],
  },
  define: {
    "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(
      configuredClerkPublishableKey ?? "",
    ),
    "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(
      configuredCliOAuthClientId ?? "",
    ),
    "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
    "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(
      repoEnv.VITE_T3CODE_RELAY_URL?.trim() ?? "",
    ),
    "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(
      repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() ?? "",
    ),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    allowedHosts,
    ...(devProxyConfig ? { proxy: devProxyConfig } : {}),
    // Pin Electron's HMR endpoint, but let browser dev derive it from the page
    // origin so remote clients don't try to connect to their own localhost.
    ...(isSingleOriginDev ? {} : { hmr: { protocol: "ws" as const, host } }),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    rollupOptions: {
      output: {
        // Split stable third-party graphs out of the index chunk so first
        // paint downloads less and long-lived vendor chunks stay cached
        // across app-code deploys. Deliberately leaves the markdown/Shiki
        // graph alone: Shiki grammars are already lazy per-language async
        // chunks, and forcing them into a sync chunk regresses first paint.
        // pnpm nests packages under node_modules/.pnpm, so match on
        // package-name segments.
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          if (
            id.includes("@tanstack/") ||
            id.includes("node_modules/effect/") ||
            id.includes("@effect/")
          ) {
            return "vendor-core";
          }
          return undefined;
        },
      },
    },
  },
});
