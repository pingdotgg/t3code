import * as NodeZlib from "node:zlib";

import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import compression from "compression";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig, type Connect, type Plugin } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

import { DEV_PROXIED_PATH_PREFIXES, isDevProxiedPath } from "@t3tools/shared/devProxy";

import { loadRepoEnv } from "../../scripts/lib/public-config";
import { tailwindPlugins } from "./vite/tailwind";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

// Single-origin dev is signalled positively, because it cannot be inferred
// from the absence of VITE_HTTP_URL/VITE_WS_URL: the runner deletes those keys
// but `loadRepoEnv` merges `.env`/`.env.local` *underneath* the process env, so
// a developer with either URL in their `.env` gets it back here. Baking it then
// pins the client to localhost and breaks every non-localhost origin — the
// exact failure single-origin mode exists to prevent, and an invisible one
// since the page still loads.
const isSingleOriginDev = process.env.T3CODE_SINGLE_ORIGIN_DEV === "1";

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredWsUrl = isSingleOriginDev ? undefined : process.env.VITE_WS_URL?.trim();
const configuredHttpUrl = isSingleOriginDev ? undefined : process.env.VITE_HTTP_URL?.trim();
// Shared dev uses direct pairing; Clerk's hosted sign-in is not configured
// for each managed environment hostname.
const configuredRelayUrl =
  process.env.T3CODE_DEV_SHARE === "connect" ? "" : repoEnv.VITE_T3CODE_RELAY_URL?.trim() || "";
const configuredClerkPublishableKey =
  process.env.T3CODE_DEV_SHARE === "connect"
    ? ""
    : repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim() || "";
const configuredClerkJwtTemplate = repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() || "";
const configuredClerkCliOAuthClientId = repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || "";
const configuredRelayTracingUrl = repoEnv.VITE_RELAY_OTLP_TRACES_URL?.trim() || "";
const configuredRelayTracingDataset = repoEnv.VITE_RELAY_OTLP_TRACES_DATASET?.trim() || "";
const configuredRelayTracingToken = repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN?.trim() || "";
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
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

// Vite 8.1's experimental bundled dev mode: serves rolldown-bundled chunks in
// dev for much faster startup/reload on large module graphs, with HMR served
// as hot patches. Opt-in while experimental: T3CODE_BUNDLED_DEV=1 pnpm dev:web
// The dev runner defaults this on for --share runs (remote browsers pay a
// round trip per import level in unbundled dev); T3CODE_BUNDLED_DEV=0 opts out.
const bundledDevEnv = process.env.T3CODE_BUNDLED_DEV?.trim().toLowerCase();
const bundledDev = bundledDevEnv === "1" || bundledDevEnv === "true";
const connectDevShare = process.env.T3CODE_DEV_SHARE === "connect";

if (connectDevShare && (!bundledDev || !["localhost", "127.0.0.1"].includes(host))) {
  throw new Error("Connect dev sharing requires bundled dev and a loopback listener.");
}

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

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
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  // Browser dev is single-origin: the backend port is proxied through this
  // server so the app works from any origin (localhost, tailnet, LAN, phone).
  // T3CODE_PORT is set by scripts/dev-runner.ts for every non-desktop mode.
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  // dev:desktop still points the renderer straight at the backend, so fall
  // back to deriving the target from the explicit websocket URL.
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

const devProxyTarget = resolveDevProxyTarget(process.env.T3CODE_PORT, configuredWsUrl);

// Vite's dev server sends JS uncompressed. On localhost that is free; over a
// shared origin (tailnet, LAN) it is the whole cold-start: bundled dev serves
// one ~25 MB chunk, and a typical uplink moves that in about a minute while
// both machines sit idle. Compressing turns it into a few seconds of CPU.
// Brotli quality 5 keeps encode time in the hundreds of ms; the default
// (quality 11) would trade the transfer stall for an equally long encode stall.
function devCompressionPlugin(): Plugin {
  return {
    name: "t3code:dev-compression",
    apply: "serve",
    configureServer(server) {
      // compression() is typed against Express's req/res, which extend the
      // node http objects Connect actually passes — safe to narrow.
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

function connectDevSharePlugin(): Plugin {
  const publicFiles = new Set([
    "/apple-touch-icon.png",
    "/favicon-16x16.png",
    "/favicon-32x32.png",
    "/favicon.ico",
    "/manifest.webmanifest",
  ]);
  return {
    name: "t3code:connect-dev-share",
    apply: "serve",
    configureServer(server) {
      // Bundled dev needs only these two inbound events. Vite's other custom
      // handlers trust their payloads and must not receive public socket input.
      server.ws.on("connection", (socket) => {
        const listeners = socket.listeners("message");
        socket.removeAllListeners("message");
        let registered = false;
        socket.on("message", (raw, isBinary) => {
          if (isBinary || !Buffer.isBuffer(raw) || raw.length > 4096) return socket.terminate();
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            return socket.terminate();
          }
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "ping"
          )
            return;
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message) ||
            message.type !== "custom" ||
            !("event" in message) ||
            !("data" in message) ||
            typeof message.data !== "object" ||
            message.data === null
          )
            return socket.terminate();
          if (
            message.event === "vite:client-connected" &&
            !registered &&
            "clientId" in message.data &&
            typeof message.data.clientId === "string" &&
            message.data.clientId.length > 0
          )
            registered = true;
          else if (
            message.event !== "vite:bundled-dev:reload-needed" ||
            !registered ||
            !("reason" in message.data) ||
            typeof message.data.reason !== "string"
          )
            return socket.terminate();
          for (const listener of listeners) listener.call(socket, raw, isBinary);
        });
      });
      server.middlewares.use((request, response, next) => {
        const [pathname = "/", query] = (request.url ?? "/").split("?", 2);
        if (isDevProxiedPath(pathname)) return next();
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Cloudflare-CDN-Cache-Control", "no-store");
        const params = new URLSearchParams(query);
        const safePath =
          pathname.startsWith("/") &&
          !/[%#\\]/u.test(pathname) &&
          !pathname.includes("/.") &&
          !pathname.endsWith(".map") &&
          !/^\/(?:src|node_modules|@|__)/u.test(pathname) &&
          !["raw", "url", "import", "direct", "sourcemap"].some((key) => params.has(key));
        if (safePath && (request.method === "GET" || request.method === "HEAD")) {
          // Only Vite's emitted files are public, never its source loader or
          // compiler endpoints. HMR patches use the same in-memory file store.
          const emitted = server.environments.client?.bundledDev?.memoryFiles.has(
            pathname.slice(1),
          );
          const assetQuery = [...params].every(
            ([key, value]) => key === "t" && /^\d+$/u.test(value),
          );
          if ((emitted || publicFiles.has(pathname)) && assetQuery) return next();
          if (pathname === "/index.html" || /^\/[a-zA-Z0-9_/-]*$/u.test(pathname)) {
            // Every navigation renders this app, even if another HTML file
            // exists in the workspace. Pairing queries stay in the browser.
            request.url = "/index.html";
            return next();
          }
        }
        response.writeHead(404).end();
      });
      server.httpServer?.prependListener("upgrade", (request, socket) => {
        const pathname = request.url?.split("?", 1)[0];
        const protocol = request.headers["sec-websocket-protocol"];
        if (
          pathname !== "/ws" &&
          pathname !== "/api/preview/forward" &&
          !(pathname === "/" && (protocol === "vite-hmr" || protocol === "vite-ping"))
        ) {
          socket.destroy();
        }
      });
    },
  };
}

// Vite rejects requests whose Host header isn't localhost, which blocks sharing
// a dev server over Tailscale/LAN. Tailnet names are safe to allow wholesale:
// the DNS is controlled by tailscale, so they can't be rebound by an attacker.
// Anything else (ngrok, a LAN IP alias) goes through the env var.
const configuredAllowedHosts = (process.env.T3CODE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig(() => {
  return {
    assetsInclude: ["**/*.wasm"],
    plugins: [
      ...(connectDevShare ? [connectDevSharePlugin()] : []),
      devCompressionPlugin(),
      // Route components load as split chunks so settings, pull-request, and
      // usage code stay out of the cold-start payload; the router prefetches
      // them on navigation intent (see getRouter's defaultPreload).
      tanstackRouter({ autoCodeSplitting: true }),
      react(),
      babel({
        // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
        // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
        // whereas the previous version of the plugin parsed all files with a .ts extension.
        // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      tailwindPlugins(bundledDev),
    ],
    optimizeDeps: {
      include: [
        "@clerk/clerk-js",
        "@clerk/react/internal",
        "@pierre/diffs",
        "@pierre/diffs/editor",
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
      // Pinned explicitly rather than left to Vite's automatic VITE_ exposure:
      // under single-origin dev this must stay empty even when a `.env`
      // supplies it, so the client falls back to window.location.origin.
      "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(configuredRelayUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(configuredClerkPublishableKey),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(configuredClerkJwtTemplate),
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(
        configuredClerkCliOAuthClientId,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": JSON.stringify(configuredRelayTracingUrl),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": JSON.stringify(
        configuredRelayTracingDataset,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": JSON.stringify(configuredRelayTracingToken),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ["react", "react-dom"],
    },
    experimental: {
      bundledDev,
    },
    server: {
      // The environment server owns credentialed API CORS, including Electron origins.
      ...(connectDevShare ? { cors: { preflightContinue: true } } : {}),
      host,
      port,
      strictPort: true,
      // The guarded public surface is intentional; the managed hostname is
      // allocated after Vite starts and backend routes retain their own auth.
      allowedHosts: connectDevShare ? (true as const) : allowedHosts,
      // Transform the whole module graph at server start instead of on the
      // first request. Without this, a cold worktree discovers and transforms
      // modules one import-level at a time while the browser waits — which
      // over a tailnet origin turns into minutes of waterfall.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      ...(devProxyTarget
        ? {
            // One entry per shared prefix; the server's dev catch-all 404s the
            // same list, so the two sides cannot drift. `/ws` is the app's own
            // socket — Vite's HMR socket is matched separately and exactly
            // (path "/" plus a vite-hmr subprotocol), so the two upgrade
            // handlers don't collide.
            proxy: Object.fromEntries(
              DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
                prefix,
                {
                  target: devProxyTarget,
                  changeOrigin: true,
                  ...(prefix === "/ws" || prefix === "/api" ? { ws: true } : {}),
                },
              ]),
            ),
          }
        : {}),
      // Electron's BrowserWindow needs the HMR socket pinned to an explicit
      // host to connect reliably; dev:desktop is the only mode that sets HOST.
      // Everywhere else, leaving this unset lets the client derive it from the
      // page origin, which is what makes HMR work over Tailscale/LAN instead of
      // failing an attempt against the wrong machine's localhost first.
      // (Vite 8 logs connection state via console.debug — enable "Verbose".)
      ...(explicitHost && !connectDevShare
        ? {
            hmr: {
              protocol: "ws",
              host: explicitHost,
              clientPort: port,
            },
          }
        : {}),
    },
    // @tailwindcss/vite only emits a CSS sourcemap when devSourcemap is on; without it
    // rolldown flags the transform as SOURCEMAP_BROKEN on every sourcemapped build.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      // Compile split chunks at startup instead of exposing Vite's arbitrary
      // module compilation endpoint. Clients still load routes on demand.
      ...(connectDevShare
        ? {
            rolldownOptions: {
              experimental: { devMode: { lazy: false } },
              output: {
                codeSplitting: {
                  groups: [
                    { name: "refresh", test: /react-refresh/, priority: 30 },
                    { name: "icons", test: /[\\/]lucide-react[\\/]/, priority: 20 },
                    { name: "shared", minShareCount: 2, includeDependenciesRecursively: true },
                  ],
                },
              },
            },
          }
        : {}),
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
    },
    test: {
      projects: [defineProject(unitTestProject)],
    },
  };
});
