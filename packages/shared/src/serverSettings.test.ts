import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("replaces sidebar organization fields so removed entries are cleared", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarProjectGroupingOverrides: {
        "env-local:/repo-a": "separate" as const,
        "env-local:/repo-b": "repository_path" as const,
      },
      sidebarProjectFolders: [
        {
          id: "folder-1",
          name: "Core",
          projectKeys: ["env-local:/repo-a", "env-local:/repo-b"],
        },
        {
          id: "folder-2",
          name: "Old",
          projectKeys: ["env-local:/repo-c"],
        },
      ],
      sidebarProjectExpandedById: {
        "folder:folder-1": false,
        "env-local:/repo-a": false,
      },
      sidebarProjectOrder: ["env-local:/repo-a", "env-local:/repo-b", "env-local:/repo-c"],
    };

    const next = applyServerSettingsPatch(current, {
      sidebarProjectGroupingOverrides: {
        "env-local:/repo-b": "repository_path",
      },
      sidebarProjectFolders: [
        {
          id: "folder-1",
          name: "Core",
          projectKeys: ["env-local:/repo-b"],
        },
      ],
      sidebarProjectExpandedById: {
        "env-local:/repo-a": false,
      },
      sidebarProjectOrder: ["env-local:/repo-b"],
    });

    expect(next.sidebarProjectGroupingOverrides).toEqual({
      "env-local:/repo-b": "repository_path",
    });
    expect(next.sidebarProjectFolders).toEqual([
      {
        id: "folder-1",
        name: "Core",
        projectKeys: ["env-local:/repo-b"],
      },
    ]);
    expect(next.sidebarProjectExpandedById).toEqual({
      "env-local:/repo-a": false,
    });
    expect(next.sidebarProjectOrder).toEqual(["env-local:/repo-b"]);
  });
});
