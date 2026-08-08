import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import {
  __resetPendingServerPatchesForTests,
  acknowledgePendingServerSettings,
  applyPendingServerPatches,
  getPendingServerPatches,
  retainPendingServerPatch,
  settlePendingServerPatch,
  subscribePendingServerPatches,
} from "./pendingServerSettings";

const environmentId = EnvironmentId.make("environment-1");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

const providerInstance = (driver: string, enabled: boolean) => ({
  driver: ProviderDriverKind.make(driver),
  enabled,
});
const retain = (patch: Parameters<typeof retainPendingServerPatch>[1]) =>
  retainPendingServerPatch(
    environmentId,
    patch,
    applyPendingServerPatches(DEFAULT_SERVER_SETTINGS, getPendingServerPatches(environmentId)),
    DEFAULT_SERVER_SETTINGS,
  );

afterEach(() => {
  __resetPendingServerPatchesForTests();
});

describe("pendingServerSettings", () => {
  it("has no overlay before a write is dispatched", () => {
    expect(getPendingServerPatches(environmentId)).toEqual([]);
    expect(getPendingServerPatches(null)).toEqual([]);
    expect(applyPendingServerPatches(DEFAULT_SERVER_SETTINGS, [])).toBe(DEFAULT_SERVER_SETTINGS);
  });

  it("keeps a second provider toggle from reverting the first one", () => {
    // Disabling codex is dispatched from the server's own (empty) map.
    const disableCodex = {
      providerInstances: { [codexId]: providerInstance("codex", false) },
    };
    retain(disableCodex);

    // Before the echo lands, the panel must already see codex disabled so the
    // next whole-map replacement it builds carries that edit forward.
    const optimistic = applyPendingServerPatches(
      DEFAULT_SERVER_SETTINGS,
      getPendingServerPatches(environmentId),
    );
    expect(optimistic.providerInstances[codexId]?.enabled).toBe(false);

    const disableClaude = {
      providerInstances: {
        ...optimistic.providerInstances,
        [claudeId]: providerInstance("claudeAgent", false),
      },
    };
    retain(disableClaude);

    const both = applyPendingServerPatches(
      DEFAULT_SERVER_SETTINGS,
      getPendingServerPatches(environmentId),
    );
    expect(both.providerInstances[codexId]?.enabled).toBe(false);
    expect(both.providerInstances[claudeId]?.enabled).toBe(false);
  });

  it("preserves a server model fallback that a queued patch did not change", () => {
    const serverFallback = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: claudeId,
        model: "claude-sonnet",
      },
    };
    const patch = {
      enableProviderUpdateChecks: false,
      textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    };
    const settings = applyPendingServerPatches(serverFallback, [
      { id: 1, patch, baseSettings: DEFAULT_SERVER_SETTINGS },
    ]);

    expect(settings.enableProviderUpdateChecks).toBe(false);
    expect(settings.textGenerationModelSelection).toEqual(
      serverFallback.textGenerationModelSelection,
    );
  });

  it("drops model options when their optimistic model change failed", () => {
    const failedModelBase = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: claudeId,
        model: "claude-sonnet",
      },
    };
    const patch = {
      textGenerationModelSelection: {
        ...failedModelBase.textGenerationModelSelection,
        options: [{ id: "reasoning_effort", value: "high" }],
      },
    };
    const settings = applyPendingServerPatches(DEFAULT_SERVER_SETTINGS, [
      { id: 1, patch, baseSettings: failedModelBase },
    ]);

    expect(settings.textGenerationModelSelection).toEqual(
      DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    );
  });

  it("rebases model option deltas without restoring failed option values", () => {
    const currentSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        ...DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        options: [{ id: "reasoning_effort", value: "low" }],
      },
    };
    const failedOptionsBase = {
      ...currentSettings,
      textGenerationModelSelection: {
        ...currentSettings.textGenerationModelSelection,
        options: [{ id: "reasoning_effort", value: "medium" }],
      },
    };
    const patch = {
      textGenerationModelSelection: {
        options: [
          { id: "reasoning_effort", value: "medium" },
          { id: "verbosity", value: "high" },
        ],
      },
    };
    const settings = applyPendingServerPatches(currentSettings, [
      { id: 1, patch, baseSettings: failedOptionsBase },
    ]);

    expect(settings.textGenerationModelSelection.options).toEqual([
      { id: "reasoning_effort", value: "low" },
      { id: "verbosity", value: "high" },
    ]);
  });

  it("rebases provider environment rows by name without duplicating them", () => {
    const environmentConfig = (value: string) => ({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      environment: [{ name: "OPENAI_API_KEY", value, sensitive: false }],
    });
    const currentSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [codexId]: environmentConfig("current") },
    };
    const failedBase = {
      ...currentSettings,
      providerInstances: { [codexId]: environmentConfig("failed") },
    };
    const patch = {
      providerInstances: { [codexId]: environmentConfig("intended") },
    };
    const settings = applyPendingServerPatches(currentSettings, [
      { id: 1, patch, baseSettings: failedBase },
    ]);

    expect(settings.providerInstances[codexId]?.environment).toEqual([
      { name: "OPENAI_API_KEY", value: "intended", sensitive: false },
    ]);
  });

  it("rebases array deltas onto a missing authoritative array", () => {
    const failedOptionsBase = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        ...DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        options: [{ id: "failed", value: true }],
      },
    };
    const patch = {
      textGenerationModelSelection: {
        options: [
          { id: "failed", value: true },
          { id: "intended", value: true },
        ],
      },
    };
    const settings = applyPendingServerPatches(DEFAULT_SERVER_SETTINGS, [
      { id: 1, patch, baseSettings: failedOptionsBase },
    ]);

    expect(settings.textGenerationModelSelection.options).toEqual([
      { id: "intended", value: true },
    ]);
  });

  it("rebases array insertions and removals without restoring failed elements", () => {
    const currentSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { codex: { customModels: ["A"] } },
    });
    const failedInsertionBase = applyServerSettingsPatch(currentSettings, {
      providers: { codex: { customModels: ["A", "B"] } },
    });
    const afterInsertion = applyPendingServerPatches(currentSettings, [
      {
        id: 1,
        patch: { providers: { codex: { customModels: ["A", "B", "C"] } } },
        baseSettings: failedInsertionBase,
      },
    ]);
    expect(afterInsertion.providers.codex.customModels).toEqual(["A", "C"]);

    const currentAfterFailedRemoval = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { codex: { customModels: ["A", "B"] } },
    });
    const failedRemovalBase = applyServerSettingsPatch(currentAfterFailedRemoval, {
      providers: { codex: { customModels: ["A"] } },
    });
    const afterRemoval = applyPendingServerPatches(currentAfterFailedRemoval, [
      {
        id: 2,
        patch: { providers: { codex: { customModels: ["A", "C"] } } },
        baseSettings: failedRemovalBase,
      },
    ]);
    expect(afterRemoval.providers.codex.customModels).toEqual(["A", "B", "C"]);
  });

  it("drops stale legacy provider edits inherited from a failed optimistic base", () => {
    const failedBase = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: { codex: { binaryPath: "/failed/codex" } },
    });
    const patch = {
      providers: {
        codex: failedBase.providers.codex,
        claudeAgent: {
          ...failedBase.providers.claudeAgent,
          binaryPath: "/selected/claude",
        },
      },
    };
    const settings = applyPendingServerPatches(DEFAULT_SERVER_SETTINGS, [
      { id: 1, patch, baseSettings: failedBase },
    ]);

    expect(settings.providers.codex.binaryPath).toBe(
      DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
    );
    expect(settings.providers.claudeAgent.binaryPath).toBe("/selected/claude");
  });

  it("retains a successful overlay until its settings echo arrives", () => {
    const patch = { providerInstances: { [codexId]: providerInstance("codex", false) } };
    const id = retain(patch);
    const settledSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);

    settlePendingServerPatch(environmentId, id, settledSettings);
    expect(getPendingServerPatches(environmentId)).toHaveLength(1);

    acknowledgePendingServerSettings(environmentId, settledSettings);
    expect(getPendingServerPatches(environmentId)).toEqual([]);
  });

  it("retires a successful overlay when its settings echo arrives before the RPC settles", () => {
    const patch = { providerInstances: { [codexId]: providerInstance("codex", false) } };
    const id = retain(patch);
    const settledSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);

    acknowledgePendingServerSettings(environmentId, settledSettings);
    expect(getPendingServerPatches(environmentId)).toHaveLength(1);

    settlePendingServerPatch(environmentId, id, settledSettings);
    expect(getPendingServerPatches(environmentId)).toEqual([]);
  });

  it("records an early echo while an older successful patch is still awaiting its echo", () => {
    const firstPatch = { enableAssistantStreaming: false };
    const firstId = retain(firstPatch);
    const secondPatch = { enableProviderUpdateChecks: false };
    const secondId = retain(secondPatch);
    const firstSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, firstPatch);
    const secondSettings = applyServerSettingsPatch(firstSettings, secondPatch);

    settlePendingServerPatch(environmentId, firstId, firstSettings);
    acknowledgePendingServerSettings(environmentId, secondSettings);
    settlePendingServerPatch(environmentId, secondId, secondSettings);

    expect(getPendingServerPatches(environmentId)).toEqual([]);
  });

  it("drops the overlay for a failed write so the server value wins again", () => {
    const id = retain({
      providerInstances: { [codexId]: providerInstance("codex", false) },
    });
    settlePendingServerPatch(environmentId, id, null);

    const settings = applyPendingServerPatches(
      DEFAULT_SERVER_SETTINGS,
      getPendingServerPatches(environmentId),
    );
    expect(settings).toBe(DEFAULT_SERVER_SETTINGS);
  });

  it("scopes pending writes to their own environment", () => {
    const otherEnvironmentId = EnvironmentId.make("environment-2");
    retain({ providerInstances: { [codexId]: providerInstance("codex", false) } });

    expect(getPendingServerPatches(otherEnvironmentId)).toEqual([]);
    expect(getPendingServerPatches(environmentId)).toHaveLength(1);
  });

  it("notifies subscribers when the pending set changes", () => {
    let notifications = 0;
    const unsubscribe = subscribePendingServerPatches(() => {
      notifications += 1;
    });

    const id = retain({ enableAssistantStreaming: false });
    settlePendingServerPatch(environmentId, id, null);
    unsubscribe();
    retain({ enableAssistantStreaming: false });

    expect(notifications).toBe(2);
  });
});
