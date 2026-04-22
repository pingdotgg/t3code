import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { createLogger, defineConfig, type LogOptions, type Logger } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredHttpUrl = process.env.VITE_HTTP_URL?.trim();
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const sourcemapEnv = process.env.HARNESS_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

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

/** Desktop `bun run dev:desktop`: Vite and Electron start in parallel; the backend is not listening yet. */
function createHarnessViteLogger(): Logger {
  const base = createLogger();
  const isDesktopDev = process.env.HARNESS_DESKTOP_DEV === "1";
  const isBenignProxyNoise = (msg: string) => {
    if (!isDesktopDev) {
      return false;
    }
    // Vite may split "http proxy error: …" and "Error: connect ECONNREFUSED" across lines.
    if (msg.includes("http proxy error")) {
      return true;
    }
    return msg.includes("ECONNREFUSED") && (msg.includes("127.0.0.1") || msg.includes("localhost"));
  };
  const withFilter =
    (fn: (msg: string, options?: LogOptions) => void) => (msg: string, options?: LogOptions) => {
      if (isBenignProxyNoise(msg)) {
        return;
      }
      fn(msg, options);
    };
  return {
    ...base,
    warn: withFilter(base.warn.bind(base)),
    error: withFilter(base.error.bind(base)),
  };
}

export default defineConfig({
  customLogger: createHarnessViteLogger(),
  plugins: [
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
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
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
});
