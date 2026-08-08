import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokCapabilitiesFromModelMeta,
  buildGrokDiscoveredModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildGrokCapabilitiesFromModelMeta", () => {
  it("maps reasoningEfforts meta into a Reasoning select descriptor", () => {
    // Opaque fixture values — not coupled to any live Grok catalog/menu.
    const caps = buildGrokCapabilitiesFromModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "effort-b",
      reasoningEfforts: [
        { id: "effort-a", value: "effort-a", label: "Effort A", default: true },
        { id: "effort-b", value: "effort-b", label: "Effort B", default: false },
        { id: "effort-c", value: "effort-c", label: "Effort C", default: false },
      ],
    });

    expect(caps.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "effort-b",
        options: [
          { id: "effort-a", label: "Effort A" },
          { id: "effort-b", label: "Effort B", isDefault: true },
          { id: "effort-c", label: "Effort C" },
        ],
      },
    ]);
  });

  it("keeps menus independent per model meta", () => {
    const caps = buildGrokCapabilitiesFromModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "only",
      reasoningEfforts: [{ id: "only", value: "only", label: "Only", default: false }],
    });
    expect(caps.optionDescriptors?.[0]?.type).toBe("select");
    if (caps.optionDescriptors?.[0]?.type === "select") {
      expect(caps.optionDescriptors[0].options.map((option) => option.id)).toEqual(["only"]);
      expect(caps.optionDescriptors[0].currentValue).toBe("only");
    }
  });

  it("returns empty capabilities when meta has no efforts", () => {
    expect(buildGrokCapabilitiesFromModelMeta(undefined).optionDescriptors).toEqual([]);
    expect(buildGrokCapabilitiesFromModelMeta({}).optionDescriptors).toEqual([]);
    expect(
      buildGrokCapabilitiesFromModelMeta({ supportsReasoningEffort: true }).optionDescriptors,
    ).toEqual([]);
  });
});

describe("buildGrokDiscoveredModelsFromSessionModelState", () => {
  it("attaches per-model capabilities from each entry's _meta", () => {
    // Pure fixtures — slugs/menus are invented so catalog renames cannot break this.
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "model-a",
      availableModels: [
        {
          modelId: "model-a",
          name: "Model A",
          _meta: {
            reasoningEffort: "effort-b",
            reasoningEfforts: [
              { value: "effort-a", label: "Effort A", default: true },
              { value: "effort-b", label: "Effort B", default: false },
              { value: "effort-c", label: "Effort C", default: false },
            ],
          },
        },
        {
          modelId: "model-b",
          name: "Model B",
          _meta: {
            reasoningEffort: "only",
            reasoningEfforts: [{ value: "only", label: "Only" }],
          },
        },
      ],
    });

    expect(models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
    expect(models[0]?.capabilities.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "effort-b",
    });
    expect(models[1]?.capabilities.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "only",
    });
    if (models[1]?.capabilities.optionDescriptors?.[0]?.type === "select") {
      expect(models[1].capabilities.optionDescriptors[0].options.map((o) => o.id)).toEqual([
        "only",
      ]);
    }
  });
});

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
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
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
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
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
