import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5173);
const STARTUP_TIMEOUT_MS = Number(process.env.T3CODE_ELECTRON_STARTUP_TIMEOUT_MS ?? 120_000);

async function canConnect(host, probePort, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(probePort, host);
  });
}

const f = (p) => path.join(import.meta.dirname, "..", p);

function inspectBundleFile(bundleFile) {
  let stat = null;
  try {
    stat = fs.statSync(bundleFile.path);
  } catch {
    return {
      ...bundleFile,
      status: "missing",
      mtimeMs: null,
      reason: "not found",
    };
  }

  return {
    ...bundleFile,
    status: "ready",
    mtimeMs: stat.mtimeMs,
    reason: "ok",
  };
}

function describeBundleStates(states) {
  return states
    .map((state) => {
      const mtime =
        typeof state.mtimeMs === "number" ? new Date(state.mtimeMs).toISOString() : "n/a";
      return `${state.label}=${state.status} (mtime=${mtime}; reason=${state.reason})`;
    })
    .join("; ");
}

function waitForDesktopBundles(timeoutMs) {
  const startedAt = Date.now();
  const bundleFiles = [
    {
      path: f("dist-electron/main.mjs"),
      label: "desktop/main.mjs",
    },
    {
      path: f("dist-electron/preload.cjs"),
      label: "desktop/preload.cjs",
    },
    {
      path: f("../server/dist/index.mjs"),
      label: "server/index.mjs",
    },
  ];
  let lastProgressLogAt = 0;

  return new Promise((resolve, reject) => {
    const tick = () => {
      const states = bundleFiles.map(inspectBundleFile);
      const missing = states.filter((state) => state.status === "missing");

      if (missing.length === 0) {
        resolve();
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        const parts = [];
        if (missing.length > 0) {
          parts.push(`missing: ${missing.map((state) => state.label).join(", ")}`);
        }
        reject(
          new Error(
            `[dev-electron] timed out after ${timeoutMs}ms waiting for bundles (${parts.join("; ")})\n[dev-electron] bundle state: ${describeBundleStates(states)}`,
          ),
        );
        return;
      }

      if (Date.now() - lastProgressLogAt >= 5_000) {
        lastProgressLogAt = Date.now();
        const waitParts = [];
        if (missing.length > 0) {
          waitParts.push(`missing=${missing.map((state) => state.label).join(",")}`);
        }
        console.log(
          `[dev-electron] still waiting for bundles after ${elapsedMs}ms (${waitParts.join("; ")})`,
        );
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

function waitForDevServer(probePort, timeoutMs) {
  const startedAt = Date.now();
  const candidates = [
    { host: "127.0.0.1", url: `http://127.0.0.1:${probePort}` },
    { host: "::1", url: `http://[::1]:${probePort}` },
    { host: "localhost", url: `http://localhost:${probePort}` },
  ];

  return new Promise((resolve, reject) => {
    const tick = () => {
      void Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          connected: await canConnect(candidate.host, probePort),
        })),
      )
        .then((results) => {
          const ready = results.find((entry) => entry.connected);
          if (ready) {
            resolve(ready.candidate.url);
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            reject(
              new Error(
                `[dev-electron] timed out after ${timeoutMs}ms waiting for renderer dev server on port ${probePort}`,
              ),
            );
            return;
          }

          setTimeout(tick, 250);
        })
        .catch((error) => {
          reject(error);
        });
    };

    tick();
  });
}

console.log("[dev-electron] waiting for desktop/server bundles");
await waitForDesktopBundles(STARTUP_TIMEOUT_MS);

console.log(`[dev-electron] waiting for renderer dev server on port ${port}`);
const devServerUrl = await waitForDevServer(port, STARTUP_TIMEOUT_MS);
console.log(`[dev-electron] launching electron with renderer url ${devServerUrl}`);

const command = process.platform === "win32" ? "electronmon.cmd" : "electronmon";
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

if (process.platform === "linux" && !childEnv.ELECTRON_DISABLE_SANDBOX) {
  childEnv.ELECTRON_DISABLE_SANDBOX = "1";
  console.log("[dev-electron] enabling ELECTRON_DISABLE_SANDBOX=1 on Linux");
}

const child = spawn(command, ["dist-electron/main.mjs"], {
  stdio: "inherit",
  env: {
    ...childEnv,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[dev-electron] failed to launch electronmon:", error.message);
  process.exit(1);
});
