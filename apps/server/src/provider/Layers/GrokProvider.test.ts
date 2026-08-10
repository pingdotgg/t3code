import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokCapabilitiesFromConfigOptions,
  buildGrokCapabilitiesFromModelInfo,
  buildGrokDiscoveredModelsFromSessionModelState,
  buildGrokPresentation,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const fakeGrokExecutableName = process.platform === "win32" ? "grok.cmd" : "grok";

function makeFakeGrokScript(lines: ReadonlyArray<string>): string {
  if (process.platform === "win32") {
    return ["@echo off", ...lines.map((line) => line), ""].join("\r\n");
  }
  return ["#!/bin/sh", ...lines, ""].join("\n");
}

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

describe("Grok ACP capability discovery", () => {
  it("builds a reasoning descriptor from the negotiated native values", () => {
    const capabilities = buildGrokCapabilitiesFromConfigOptions([
      {
        id: "native-thought-level",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: "balanced",
        options: [
          { value: "quick", name: "Quick" },
          { value: "balanced", name: "Balanced" },
          { value: "deep-native", name: "Deep Native" },
        ],
      },
    ]);

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        currentValue: "balanced",
        options: [
          { id: "quick", label: "Quick" },
          { id: "balanced", label: "Balanced", isDefault: true },
          { id: "deep-native", label: "Deep Native" },
        ],
      },
    ]);
  });

  it("builds a reasoning descriptor from Grok's verified model metadata", () => {
    const capabilities = buildGrokCapabilitiesFromModelInfo({
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        totalContextTokens: 500000,
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          {
            id: "high",
            value: "high",
            label: "High Effort",
            description: "Highest implementation quality",
            default: true,
          },
          { id: "medium", value: "medium", label: "Medium Effort", default: false },
        ],
      },
    });

    expect(capabilities.optionDescriptors?.[0]).toMatchObject({
      id: "reasoning",
      type: "select",
      currentValue: "high",
      options: [
        { id: "high", label: "High Effort", isDefault: true },
        { id: "medium", label: "Medium Effort" },
      ],
    });
  });

  it("keeps custom models empty and hides Plan until the pair is negotiated", () => {
    const capabilities = buildGrokCapabilitiesFromConfigOptions([]);
    const models = buildGrokDiscoveredModelsFromSessionModelState(
      {
        currentModelId: "grok-build",
        availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
      },
      capabilities,
    );

    expect(models[0]?.capabilities).toEqual({ optionDescriptors: [] });
    expect(buildGrokPresentation(undefined).showInteractionModeToggle).toBe(false);
    expect(
      buildGrokPresentation({
        currentModeId: "code",
        availableModes: [
          { id: "architect", name: "Architect" },
          { id: "code", name: "Code" },
        ],
      }).showInteractionModeToggle,
    ).toBe(true);
  });
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
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
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, fakeGrokExecutableName);
          yield* fs.writeFileString(
            grokPath,
            makeFakeGrokScript(
              process.platform === "win32"
                ? [`echo ${secretStderr} 1>&2`, "exit /b 2"]
                : [`printf "%s\\n" "${secretStderr}" >&2`, "exit 2"],
            ),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, fakeGrokExecutableName);
          yield* fs.writeFileString(
            grokPath,
            makeFakeGrokScript(
              process.platform === "win32"
                ? ["echo grok-cli 0.0.99", "exit /b 0"]
                : ['printf "grok-cli 0.0.99\\n"', "exit 0"],
            ),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
