// @effect-diagnostics nodeBuiltinImport:off
// Scenarios: e2e tests that run against the real dev stack. See docs/operations/scenarios.md.
import * as NodePath from "node:path";

import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/** The checkout whose app runs. `prove-scenario.ts` points it at a base or head worktree. */
export const APP_DIR = NodePath.resolve(process.env.T3_SCENARIO_APP_DIR ?? "..");
/** A T3 home only scenarios use, recreated on every run. `.t3` is gitignored. */
export const T3_HOME = NodePath.resolve(import.meta.dirname, "../.t3/scenarios");

export default {
  tests: "scenarios/**/*.e2e.ts",
  targets: [
    {
      engine: web({ viewport: { width: 1280, height: 800 } }),
      app: {
        url: "http://127.0.0.1:0",
        // Vite answers before the server does; this path is proxied to the server.
        readyUrl: "http://127.0.0.1:{port}/.well-known/t3/environment",
        command: {
          executable: process.execPath,
          args: [NodePath.join(import.meta.dirname, "scenarios/start-app.ts"), T3_HOME, "{port}"],
          cwd: APP_DIR,
          startupTimeout: 300_000,
          log: ".e2e/app.log",
        },
      },
    },
  ],
  // One server holds every test's state, and a dev stack is heavy.
  workers: 1,
  timeout: 120_000,
  assertionTimeout: 15_000,
  video: "on",
  trace: "on",
  reporters: ["list", "markdown"],
} satisfies E2EConfig;
