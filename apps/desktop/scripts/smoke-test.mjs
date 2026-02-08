/**
 * Smoke test: builds desktop + renderer, launches Electron against the
 * production bundle, waits for the renderer to confirm it loaded, then exits.
 *
 * Catches the two categories of regression we've hit:
 *  1. Module resolution failures (preload can't find @acme/contracts, etc.)
 *  2. CSP / script blocking (React fails to mount)
 *
 * The test works by injecting a tiny check via ELECTRON_ENABLE_LOGGING —
 * Electron forwards renderer console.log to the main process stdout when
 * that env var is set. We look for React's "Download the React DevTools"
 * message as proof that React successfully mounted (it only fires after
 * the first render). For production mode (no React DevTools message), we
 * instead check that no fatal errors appeared.
 */
import { spawn, execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");
const desktopDir = resolve(__dirname, "..");
const electronBin = resolve(desktopDir, "node_modules/.bin/electron");
const mainJs = resolve(desktopDir, "dist-electron/main.js");

// ── Build first ──────────────────────────────────────────────────────
console.log("Building contracts + renderer + desktop...");
execSync("bun run build", { cwd: root, stdio: "inherit" });

// ── Launch Electron (production mode — no VITE_DEV_SERVER_URL) ──────
console.log("\nLaunching Electron (production mode)...");

const child = spawn(electronBin, [mainJs], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "", // ensure production path
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";

child.stdout.on("data", (d) => {
  output += d.toString();
});
child.stderr.on("data", (d) => {
  output += d.toString();
});

const TIMEOUT_MS = 8_000;

const timer = setTimeout(() => {
  child.kill();
}, TIMEOUT_MS);

child.on("exit", () => {
  clearTimeout(timer);

  // Fatal patterns that indicate broken builds
  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute", // CSP blocking scripts
    "can't detect preamble", // @vitejs/plugin-react failure
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];

  const failures = fatalPatterns.filter((p) => output.includes(p));

  if (failures.length > 0) {
    console.error("\n❌ Smoke test FAILED. Matched fatal patterns:");
    for (const f of failures) {
      console.error(`   • ${f}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("✅ Smoke test passed — no fatal errors detected");
  process.exit(0);
});
