import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgySettings } from "@t3tools/contracts";

import {
  agyModelsFromSettings,
  buildInitialAgyProviderSnapshot,
  checkAgyProviderStatus,
  parseAgyModelsOutput,
} from "./AgyProvider.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);

describe("buildInitialAgyProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAgyProviderSnapshot(
        decodeAgySettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default — Antigravity is enabled by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAgyProviderSnapshot(decodeAgySettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Antigravity");
      expect(snapshot.requiresNewThreadForModelChange).toBeUndefined();
    }),
  );
});

describe("parseAgyModelsOutput", () => {
  it("parses the tab-separated model catalog", () => {
    const models = parseAgyModelsOutput(
      [
        "Fetching available models...",
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
        "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
        "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash" },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    ]);
    expect(models.find((model) => model.slug === "gemini-3.7-flash-high")?.isLegacy).toBeFalsy();
    const claude = models.find((model) => model.slug === "claude-sonnet-4-6");
    expect(claude?.isLegacy).toBe(true);
    expect(claude?.capabilities).toBeNull();
    const capabilities = models[0]?.capabilities;
    expect(capabilities).not.toBeNull();
    expect(capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "high",
      options: [{ id: "low" }, { id: "medium" }, { id: "high", isDefault: true }],
    });
  });

  it("parses the escaped tab delimiter emitted by agy 1.1.x", () => {
    const models = parseAgyModelsOutput("gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\n");

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash" },
    ]);
  });
});

describe("agyModelsFromSettings", () => {
  it("does not append reasoning variants as custom models", () => {
    const models = agyModelsFromSettings([
      "gemini-3.7-flash-low",
      "gemini-3.7-flash-medium",
      "my-custom-model",
    ]);

    expect(models.map((model) => model.slug)).not.toContain("gemini-3.7-flash-low");
    expect(models.map((model) => model.slug)).not.toContain("gemini-3.7-flash-medium");
    expect(models.map((model) => model.slug)).toContain("my-custom-model");
  });
});

it.layer(NodeServices.layer)("checkAgyProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAgyProviderStatus(
        decodeAgySettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/agy-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not found on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as ready when --version succeeds", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-version-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(
            agyPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "models" ]; then',
              '  printf "gemini-test\\tGemini Test\\n"',
              "else",
              '  echo "agy version 1.1.19"',
              "fi",
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAgyProviderStatus(
            decodeAgySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.version).toBe("1.1.19");
      expect(snapshot.models.length).toBeGreaterThan(0);
      expect(snapshot.models[0]?.slug).toBe("gemini-test");
    }),
  );

  it.effect("reports a signed-out CLI as unauthenticated", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-auth-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(
            agyPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "models" ]; then',
              '  echo "Error: Please sign in to view available models. Launch the CLI without arguments to sign in." >&2',
              "  exit 1",
              "fi",
              'echo "agy version 1.1.19"',
              "",
            ].join("\n"),
          );
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAgyProviderStatus(
            decodeAgySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toBe(
        "Antigravity CLI is not authenticated. Launch `agy` to sign in.",
      );
    }),
  );
});
