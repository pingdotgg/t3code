import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AntigravitySettings } from "@t3tools/contracts";

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
} from "./AntigravityProvider.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const isWindows = process.platform === "win32";

/**
 * Creates a Node.js-backed script stub that runs identically on Windows and Unix.
 */
function makeNodeStub(dir: string, fileName: string, jsCode: string): string {
  const fs = require("node:fs");
  const path = require("node:path");
  const jsPath = path.join(dir, `${fileName}-runner.js`);
  fs.writeFileSync(jsPath, jsCode, "utf8");

  if (isWindows) {
    const cmdPath = path.join(dir, `${fileName}.cmd`);
    fs.writeFileSync(cmdPath, `@echo off\n"${process.execPath}" "${jsPath}" %*\n`, "utf8");
    return cmdPath;
  } else {
    const shPath = path.join(dir, fileName);
    fs.writeFileSync(
      shPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsPath)} "$@"\n`,
      "utf8",
    );
    fs.chmodSync(shPath, 0o755);
    return shPath;
  }
}

describe("buildInitialAntigravityProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({}),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Antigravity");
      // Model switching is supported in-session via per-turn --model
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      // Interaction mode toggle is hidden because --print mode behavior is undocumented
      expect(snapshot.showInteractionModeToggle).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkAntigravityProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/agy-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-version-" });
          const agyPath = makeNodeStub(
            dir,
            "agy",
            `console.error("broken antigravity install"); process.exit(2);`,
          );

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Antigravity CLI is installed but failed to run.");
    }),
  );

  it.effect("reports unauthenticated when --version passes but agy models returns nothing", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-no-models-" });
          const agyPath = makeNodeStub(
            dir,
            "agy",
            `
const args = process.argv.join(" ");
if (args.includes("--version")) {
  console.log("Antigravity CLI 1.2.3");
  process.exit(0);
}
process.exit(0);
`,
          );

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth?.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("sign in");
    }),
  );

  it.effect("returns ready status when version and models are available", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-success-" });
          const agyPath = makeNodeStub(
            dir,
            "agy",
            `
const args = process.argv.join(" ");
if (args.includes("--version")) {
  console.log("Antigravity CLI 1.2.3");
  process.exit(0);
}
if (args.includes("models")) {
  console.log("gemini-3.1-pro-high\\ngemini-3.6-flash-low");
  process.exit(0);
}
process.exit(0);
`,
          );

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.models.length).toBeGreaterThan(0);
    }),
  );
});
