import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 5733);
const serverPort = Number(process.env.T3CODE_PORT ?? 3773);
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();
const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "..", "..");
const serverCwd = path.resolve(repoRoot, "apps", "server");
const devServerUrl = `http://localhost:${port}`;
let devServerProcess: ReturnType<typeof spawn> | null = null;
let devServerStarting = false;

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const isPortOpen = (targetPort: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(targetPort, "127.0.0.1");
    const finalize = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(400);
    socket.on("connect", () => finalize(true));
    socket.on("timeout", () => finalize(false));
    socket.on("error", () => finalize(false));
  });

const startDevServer = async () => {
  if (devServerStarting) return;
  devServerStarting = true;
  try {
    if (await isPortOpen(serverPort)) {
      return;
    }
    if (devServerProcess && devServerProcess.exitCode === null) {
      return;
    }
    devServerProcess = spawn("bun", ["run", "dev"], {
      cwd: serverCwd,
      stdio: "inherit",
      env: {
        ...process.env,
        T3CODE_PORT: String(serverPort),
        VITE_DEV_SERVER_URL: devServerUrl,
        T3CODE_NO_BROWSER: "1",
      },
    });
    devServerProcess.on("exit", () => {
      devServerProcess = null;
    });
  } finally {
    setTimeout(() => {
      devServerStarting = false;
    }, 2000);
  }
};

const devStartPlugin = () => ({
  name: "t3-dev-start",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use(
      "/api/dev-start",
      (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "text/plain");
          res.end("Method not allowed");
          return;
        }
        void startDevServer()
          .then(() => {
            res.statusCode = 202;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ status: "starting" }));
          })
          .catch((error) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                status: "error",
                message: error instanceof Error ? error.message : "Unable to start dev server",
              }),
            );
          });
      },
    );
  },
});

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
    devStartPlugin(),
  ],
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
});
