// @effect-diagnostics nodeBuiltinImport:off - Vite config runs in Node and resolves local brand asset files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
  resolveWebAssetBrandForConfiguredChannel,
  resolveWebIconOverrides,
} from "../../scripts/lib/brand-assets.ts";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    // The web runtime suite exercises auth bootstrap, saved environments,
    // and websocket subscription lifecycles. Under the full monorepo test
    // run, those async tests can exceed Vitest's default 5s budget.
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration;

const browserTestProject = {
  extends: true,
  server: {
    // Browser tests need concurrent runs to claim the next available port.
    strictPort: false,
  },
  test: {
    name: "browser",
    include: ["src/components/**/*.browser.tsx"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: playwright() as never,
      instances: [{ browser: "chromium" }],
      headless: true,
      api: {
        strictPort: false,
      },
    },
    fileParallelism: false,
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined {
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl);
const webAssetBrand = resolveWebAssetBrandForConfiguredChannel(configuredHostedAppChannel);
const serviceWorkerFilename = "t3-service-worker.js";
const pushServiceWorkerFilename = "t3-push-service-worker.js";
const pushServiceWorkerVersion = createHash("sha256")
  .update(
    readFileSync(fileURLToPath(new URL(`./public/${pushServiceWorkerFilename}`, import.meta.url))),
  )
  .digest("hex")
  .slice(0, 8);

function webBrandAssetsPlugin(): Plugin {
  return {
    name: "t3code-web-brand-assets",
    configureServer(server) {
      const devOverrides = new Map(
        resolveWebIconOverrides("development", "").map((override) => [
          `/${override.targetRelativePath.replace(/^\//, "")}`,
          path.join(repoRoot, override.sourceRelativePath),
        ]),
      );
      server.middlewares.use((req, res, next) => {
        const handleRequest = async () => {
          const urlPath = req.url?.split("?")[0];
          if (!urlPath) {
            next();
            return;
          }
          const sourcePath = devOverrides.get(urlPath);
          if (!sourcePath) {
            next();
            return;
          }
          const data = await fs.readFile(sourcePath);
          res.setHeader("Content-Type", urlPath.endsWith(".ico") ? "image/x-icon" : "image/png");
          res.setHeader("Cache-Control", "no-cache");
          res.end(data);
        };
        void handleRequest().catch(next);
      });
    },
    async closeBundle() {
      await Promise.all(
        resolveWebIconOverrides(webAssetBrand, "apps/web/dist").map((override) =>
          fs.copyFile(
            path.join(repoRoot, override.sourceRelativePath),
            path.join(repoRoot, override.targetRelativePath),
          ),
        ),
      );
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
    }),
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
    webBrandAssetsPlugin(),
    VitePWA({
      filename: serviceWorkerFilename,
      injectRegister: false,
      manifest: false,
      registerType: "prompt",
      workbox: {
        cleanupOutdatedCaches: true,
        globIgnores: [`**/${serviceWorkerFilename}`, `**/${pushServiceWorkerFilename}`],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,woff2}"],
        importScripts: [`${pushServiceWorkerFilename}?v=${pushServiceWorkerVersion}`],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/attachments(?:\/|$)/,
          /^\/\.well-known(?:\/|$)/,
        ],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 365,
                maxEntries: 10,
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 365,
                maxEntries: 30,
              },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    include: [
      "@base-ui/react/checkbox",
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "effect/Array",
      "effect/Order",
      "react-dom/client",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
    "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
    "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    ...(devProxyTarget
      ? {
          proxy: {
            "/.well-known": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/api": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/attachments": {
              target: devProxyTarget,
              changeOrigin: true,
            },
          },
        }
      : {}),
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
  test: {
    projects: [defineProject(unitTestProject), defineProject(browserTestProject)],
  },
});
