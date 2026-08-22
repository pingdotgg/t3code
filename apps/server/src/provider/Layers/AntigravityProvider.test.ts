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
  parseAntigravityModels,
} from "./AntigravityProvider.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

describe("parseAntigravityModels", () => {
  it("normalizes and deduplicates model list with effort suffixes", () => {
    const rawOutput = [
      "gemini-3.7-flash-high     Gemini 3.7 Flash (High)",
      "gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)",
      "gemini-3.7-flash-low      Gemini 3.7 Flash (Low)",
      "gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
      "gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
      "gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
      "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
    ].join("\n");

    const models = parseAntigravityModels(rawOutput);

    expect(models.map((m) => m.slug)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "claude-sonnet-4-6",
      "gpt-oss-120b",
    ]);

    expect(models.map((m) => m.name)).toEqual([
      "Gemini 3.7 Flash",
      "Gemini 3.6 Flash",
      "Claude Sonnet 4.6 (Thinking)",
      "GPT-OSS 120B",
    ]);

    for (const model of models) {
      const effortOption = model.capabilities?.optionDescriptors?.find((d) => d.id === "effort");
      expect(effortOption).toBeDefined();
      expect(effortOption?.type).toBe("select");
      if (effortOption?.type === "select") {
        expect(effortOption.options.map((o) => o.id)).toEqual(["low", "medium", "high"]);
      }
    }
  });
});

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
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkAntigravityProviderStatus", (it) => {
  it.effect("reports binary as missing when binary path does not resolve", () =>
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

  it.effect("reports an installed CLI as unhealthy when --help exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken agy install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-help-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(
            agyPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe(
        "Antigravity CLI is installed but exited with non-zero status.",
      );
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports ready when binary outputs help successfully", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-success-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(
            agyPath,
            ["#!/bin/sh", 'printf "Usage of agy:\\n  --help\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({
              enabled: true,
              binaryPath: agyPath,
              accountEmail: "developer@example.com",
            }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth?.status).toBe("authenticated");
      expect(snapshot.auth?.email).toBe("developer@example.com");
    }),
  );
});
