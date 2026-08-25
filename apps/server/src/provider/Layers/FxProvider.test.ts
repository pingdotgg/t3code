// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FxSettings } from "@t3tools/contracts";

import { buildInitialFxProviderSnapshot, checkFxProviderStatus } from "./FxProvider.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("buildInitialFxProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialFxProviderSnapshot(decodeFxSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — fx is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialFxProviderSnapshot(decodeFxSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialFxProviderSnapshot(decodeFxSettings({ enabled: true }));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking fx");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkFxProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkFxProviderStatus(
        decodeFxSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/fx-binary",
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
      const secretStderr = "broken fx install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fx-version-" });
          const fxPath = path.join(dir, "fx");
          yield* fs.writeFileString(
            fxPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(fxPath, 0o755);

          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("fx CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("discovers the active fx model catalog through standard ACP config options", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fx-acp-success-" });
          const fxPath = path.join(dir, "fx");
          yield* fs.writeFileString(
            fxPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "fx 0.0.99\\n"',
              "  exit 0",
              "fi",
              'if [ "$1" != "acp" ]; then',
              '  printf "%s\\n" "unexpected args: $*" >&2',
              "  exit 11",
              "fi",
              `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(mockAgentPath)}`,
              "",
            ].join("\n"),
          );
          yield* fs.chmod(fxPath, 0o755);

          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.0.99");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "composer-2",
        "composer-2[fast=true]",
        "gpt-5.3-codex[reasoning=medium,fast=false]",
      ]);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fx-success-" });
          const fxPath = path.join(dir, "fx");
          yield* fs.writeFileString(
            fxPath,
            ["#!/bin/sh", 'printf "fx-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(fxPath, 0o755);

          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
