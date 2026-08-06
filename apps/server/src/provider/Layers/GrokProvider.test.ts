import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokDiscoveredModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokModelCapabilitiesFromReasoningEffortMenu,
  grokReasoningEffortMenuFromAcpMeta,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

/** Shape observed live from `grok agent stdio` `session/new` (grok 0.2.117). */
const GROK_4_5_ACP_META = {
  totalContextTokens: 500000,
  agentType: "grok-build-plan",
  supportsReasoningEffort: true,
  reasoningEffort: "high",
  reasoningEfforts: [
    {
      id: "high",
      value: "high",
      label: "High Effort",
      description: "Highest implementation quality with extensive reasoning",
      default: true,
    },
    { id: "medium", value: "medium", label: "Medium Effort", default: false },
    { id: "low", value: "low", label: "Low Effort", default: false },
  ],
};

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

describe("grokReasoningEffortMenuFromAcpMeta", () => {
  it("maps the advertised menu with labels, descriptions, and the default", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta(GROK_4_5_ACP_META);
    expect(menu).toEqual({
      entries: [
        {
          id: "high",
          label: "High",
          description: "Highest implementation quality with extensive reasoning",
          isDefault: true,
        },
        { id: "medium", label: "Medium", isDefault: false },
        { id: "low", label: "Low", isDefault: false },
      ],
      currentValue: "high",
    });
  });

  it("prefers the advertised current effort over the menu default", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta({
      ...GROK_4_5_ACP_META,
      reasoningEffort: "low",
    });
    expect(menu?.currentValue).toBe("low");
  });

  it("falls back to the default entry when the current effort is unknown", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta({
      ...GROK_4_5_ACP_META,
      reasoningEffort: "turbo",
    });
    expect(menu?.currentValue).toBe("high");
  });

  it("prefers the advertised spawn value over the menu id", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta({
      supportsReasoningEffort: true,
      reasoningEfforts: [{ id: "menu-high", value: "high", label: "High Effort", default: true }],
    });
    expect(menu?.entries[0]?.id).toBe("high");
  });

  it("prefers valid values, falls back to valid ids, and drops invalid entries", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta({
      supportsReasoningEffort: true,
      reasoningEfforts: [
        { id: "high", value: "not a token", label: "High Effort", default: true },
        { id: "menu-low", value: "low", label: "Low Effort" },
        { id: "medium", value: "", label: "Medium Effort" },
        { id: "bad id", value: "not a token", label: "Bad" },
      ],
    });
    expect(menu?.entries.map((entry) => entry.id)).toEqual(["high", "low", "medium"]);
    expect(menu?.currentValue).toBe("high");
  });

  it("returns undefined when meta carries no effort information", () => {
    expect(grokReasoningEffortMenuFromAcpMeta(undefined)).toBeUndefined();
    expect(grokReasoningEffortMenuFromAcpMeta(null)).toBeUndefined();
    expect(grokReasoningEffortMenuFromAcpMeta({ totalContextTokens: 1 })).toBeUndefined();
    expect(grokReasoningEffortMenuFromAcpMeta({ supportsReasoningEffort: true })).toBeUndefined();
  });

  it("returns null when the agent explicitly reports no usable menu", () => {
    expect(grokReasoningEffortMenuFromAcpMeta({ supportsReasoningEffort: false })).toBeNull();
    expect(
      grokReasoningEffortMenuFromAcpMeta({ supportsReasoningEffort: true, reasoningEfforts: [] }),
    ).toBeNull();
    expect(
      grokReasoningEffortMenuFromAcpMeta({
        supportsReasoningEffort: true,
        reasoningEfforts: [{ label: "No id" }],
      }),
    ).toBeNull();
    expect(
      grokReasoningEffortMenuFromAcpMeta({
        supportsReasoningEffort: true,
        reasoningEfforts: { high: true },
      }),
    ).toBeNull();
    expect(
      grokReasoningEffortMenuFromAcpMeta({
        supportsReasoningEffort: true,
        reasoningEfforts: "high",
      }),
    ).toBeNull();
  });

  it("excludes malformed effort tokens that spawn would drop", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta({
      supportsReasoningEffort: true,
      reasoningEfforts: [
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "bad space", value: "not a token", label: "Bad" },
        { id: "-leading-dash", value: "-leading-dash", label: "Dash" },
        { id: "x".repeat(33), value: "x".repeat(33), label: "Long" },
        { id: "future", value: "turbo_v2", label: "Turbo V2 Effort" },
      ],
    });
    expect(menu?.entries.map((entry) => entry.id)).toEqual(["high", "turbo_v2"]);
    expect(menu?.entries.find((entry) => entry.id === "turbo_v2")?.label).toBe("Turbo V2");
  });

  it("keeps prototype-key effort ids as string labels via the fallback path", () => {
    // A plain-object label lookup of "constructor" would yield a function and
    // break the provider snapshot string schema; Map lookup falls through to
    // the raw-label / id string path.
    const menu = grokReasoningEffortMenuFromAcpMeta({
      supportsReasoningEffort: true,
      reasoningEfforts: [
        { id: "constructor", value: "constructor", label: "Constructor Effort", default: true },
        { id: "toString", value: "toString", label: "ToString Effort" },
      ],
    });
    expect(menu?.entries).toEqual([
      { id: "constructor", label: "Constructor", isDefault: true },
      { id: "toString", label: "ToString", isDefault: false },
    ]);
    for (const entry of menu?.entries ?? []) {
      expect(typeof entry.label).toBe("string");
    }
  });
});

describe("grokModelCapabilitiesFromReasoningEffortMenu", () => {
  it("emits a Reasoning select descriptor for an advertised menu", () => {
    const menu = grokReasoningEffortMenuFromAcpMeta(GROK_4_5_ACP_META);
    const capabilities = grokModelCapabilitiesFromReasoningEffortMenu(menu);
    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: "high",
            label: "High",
            description: "Highest implementation quality with extensive reasoning",
            isDefault: true,
          },
          { id: "medium", label: "Medium" },
          { id: "low", label: "Low" },
        ],
        currentValue: "high",
      },
    ]);
  });

  it("returns empty descriptors without a menu", () => {
    expect(grokModelCapabilitiesFromReasoningEffortMenu(undefined).optionDescriptors).toEqual([]);
  });
});

describe("buildGrokDiscoveredModelsFromSessionModelState", () => {
  it("advertises the reasoning menu from model _meta", () => {
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "grok-4.5",
      availableModels: [
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: GROK_4_5_ACP_META },
        { modelId: "grok-lite", name: "Grok Lite" },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual(["grok-4.5", "grok-lite"]);
    expect(models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
    ]);
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("falls back to the known grok-4.5 menu when _meta omits the efforts", () => {
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "grok-4.5",
      availableModels: [{ modelId: "grok-4.5", name: "Grok 4.5" }],
    });
    const descriptor = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(descriptor).toMatchObject({ id: "reasoningEffort", currentValue: "high" });
    expect(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
    ).toEqual(["high", "medium", "low"]);
  });

  it("does not resolve prototype-inherited keys as fallback menus", () => {
    // A Record lookup of "constructor" would yield Object.prototype.constructor;
    // Map / Object.hasOwn must keep prototype keys out of the fallback catalog.
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "constructor",
      availableModels: [
        { modelId: "constructor", name: "Constructor" },
        { modelId: "toString", name: "ToString" },
        { modelId: "__proto__", name: "Proto" },
      ],
    });
    for (const model of models) {
      expect(model.capabilities?.optionDescriptors ?? []).toEqual([]);
    }
  });

  it("suppresses the fallback when _meta explicitly reports no support", () => {
    const models = buildGrokDiscoveredModelsFromSessionModelState({
      currentModelId: "grok-4.5",
      availableModels: [
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: { supportsReasoningEffort: false } },
      ],
    });
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([]);
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
