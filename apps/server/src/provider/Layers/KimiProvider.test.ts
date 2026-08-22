// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KimiSettings } from "@t3tools/contracts";

import { buildInitialKimiProviderSnapshot, checkKimiProviderStatus } from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const isWin = process.platform === "win32";

function writeFakeKimiBinary(
  fs: FileSystem.FileSystem["Service"],
  dir: string,
  path: Path.Path["Service"],
  scriptBody: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const jsPath = path.join(dir, "kimi.mjs");
    yield* fs.writeFileString(jsPath, scriptBody);
    if (isWin) {
      const cmdPath = path.join(dir, "kimi.cmd");
      yield* fs.writeFileString(
        cmdPath,
        ["@echo off", `node "${jsPath.replaceAll("/", "\\")}" %*`, ""].join("\r\n"),
      );
      return cmdPath;
    }
    const shPath = path.join(dir, "kimi");
    yield* fs.writeFileString(
      shPath,
      ["#!/bin/sh", `exec "${process.execPath}" "${jsPath}" "$@"`, ""].join("\n"),
    );
    yield* fs.chmod(shPath, 0o755);
    return shPath;
  });
}

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kimi");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimi-code/k3",
        "kimi-code/k3-256k",
        "kimi-code/kimi-for-coding",
        "kimi-code/kimi-for-coding-highspeed",
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkKimiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({
          enabled: true,
          binaryPath: NodePath.join(NodeOS.tmpdir(), "definitely-not-installed-kimi-binary"),
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
      const secretStderr = "broken kimi install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-version-" });
          const kimiPath = yield* writeFakeKimiBinary(
            fs,
            dir,
            path,
            [
              "const args = process.argv.slice(2);",
              `process.stderr.write(${JSON.stringify(secretStderr + "\\n")});`,
              "process.exit(2);",
              "",
            ].join("\n"),
          );

          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kimi CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-success-" });
          const kimiPath = yield* writeFakeKimiBinary(
            fs,
            dir,
            path,
            [
              "const args = process.argv.slice(2);",
              'if (args[0] === "--version") {',
              '  process.stdout.write("kimi-cli 0.0.99\\n");',
              "  process.exit(0);",
              "}",
              'process.stderr.write("not an acp agent\\n");',
              "process.exit(1);",
              "",
            ].join("\n"),
          );

          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimi-code/k3",
        "kimi-code/k3-256k",
        "kimi-code/kimi-for-coding",
        "kimi-code/kimi-for-coding-highspeed",
      ]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
