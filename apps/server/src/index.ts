import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixPath } from "./fixPath";
import { createLogger } from "./logger";
import { createServer } from "./wsServer";

fixPath();

const DEFAULT_PORT = 3773;
// Dummy comment for a no-op change request.
// Additional dummy comment requested in chat.
const cwd = process.cwd();
const logger = createLogger("server");

type RuntimeMode = "web" | "desktop";

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid T3CODE_PORT: ${value}`);
  }
  return parsed;
}

function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveStateDir(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) {
    return path.join(os.homedir(), ".t3", "userdata");
  }
  return path.resolve(expandHomePath(raw.trim()));
}

async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // Preferred port busy — let the OS pick one
      const fallback = net.createServer();
      fallback.listen(0, () => {
        const addr = fallback.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        fallback.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error("Could not find an available port."));
        });
      });
      fallback.on("error", reject);
    });
  });
}

function resolveStaticDir(): string | undefined {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // Check for bundled client (npm publish / npx scenario):
  // dist/client/ lives alongside dist/index.js
  const bundledClient = path.resolve(__dirname, "client");
  try {
    const stat = fs.statSync(path.join(bundledClient, "index.html"));
    if (stat.isFile()) return bundledClient;
  } catch {
    // Not bundled — check monorepo layout
  }

  // Monorepo layout: apps/server/dist/index.js → apps/web/dist/
  const monorepoClient = path.resolve(__dirname, "../../web/dist");
  try {
    const stat = fs.statSync(path.join(monorepoClient, "index.html"));
    if (stat.isFile()) return monorepoClient;
  } catch {
    // Not found — probably dev mode, Vite will serve
  }

  return undefined;
}

async function main() {
  const mode: RuntimeMode = process.env.T3CODE_MODE === "desktop" ? "desktop" : "web";
  const requestedPort = parsePort(process.env.T3CODE_PORT);
  const port =
    requestedPort ?? (mode === "desktop" ? DEFAULT_PORT : await findAvailablePort(DEFAULT_PORT));
  const stateDir = resolveStateDir(process.env.T3CODE_STATE_DIR);
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const noBrowser = parseBooleanEnv(process.env.T3CODE_NO_BROWSER) ?? mode === "desktop";
  const authToken = process.env.T3CODE_AUTH_TOKEN;
  const staticDir = devUrl ? undefined : resolveStaticDir();

  if (!devUrl && !staticDir) {
    logger.warn("web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable", {
      hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
    });
  }

  const server = createServer({
    port,
    host: mode === "desktop" ? "127.0.0.1" : undefined,
    cwd,
    stateDir,
    staticDir,
    devUrl,
    authToken,
  });
  await server.start();

  const url = `http://localhost:${port}`;
  logger.info("T3 Code running", {
    url,
    cwd,
    mode,
    stateDir,
    authEnabled: Boolean(authToken),
  });

  // Open browser (dynamic import because `open` is ESM-only)
  if (!noBrowser) {
    try {
      const open = await import("open");
      const target = devUrl ?? url;
      await open.default(target);
    } catch {
      logger.info("browser auto-open unavailable", {
        hint: `Open ${devUrl ?? url} in your browser.`,
      });
    }
  }

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    try {
      await server.stop();
      process.exit(0);
    } catch (error) {
      logger.error("failed to stop server cleanly", { error });
      process.exit(1);
    }
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  logger.error("failed to start T3 Code", { error: err });
  process.exit(1);
});
