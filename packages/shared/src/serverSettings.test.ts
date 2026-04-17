import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
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
      textGenerationModelSelection: {
        provider: "codex" as const,
        model: "gpt-5.4-mini",
        options: {
          reasoningEffort: "high" as const,
          fastMode: true,
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          provider: "codex",
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        provider: "codex" as const,
        model: "gpt-5.4-mini",
        options: {
          reasoningEffort: "high" as const,
          fastMode: true,
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: {
            fastMode: false,
          },
        },
      }).textGenerationModelSelection,
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: {
        reasoningEffort: "high",
        fastMode: false,
      },
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        provider: "codex" as const,
        model: "gpt-5.4-mini",
        options: {
          reasoningEffort: "high" as const,
          fastMode: true,
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      provider: "opencode",
      model: "openai/gpt-5",
    });
  });
});
