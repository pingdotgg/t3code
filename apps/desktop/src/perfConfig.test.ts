import { describe, expect, it } from "vitest";

import {
  resolveBenchmarkFollowUpPassCount,
  shouldRunBenchmarkThreadSweep,
  shouldRunOptionalRendererPerfInteractions,
  shouldRunTerminalPerfInteractions,
} from "./perfConfig";

describe("shouldRunTerminalPerfInteractions", () => {
  it("defaults to enabled outside CI when env is unset", () => {
    expect(shouldRunTerminalPerfInteractions({ CI: "false" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: "0" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: "off" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: "no" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: undefined })).toBe(true);
  });

  it("defaults to disabled in CI when env is unset", () => {
    expect(shouldRunTerminalPerfInteractions({ CI: "true" })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: "TRUE" })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: "1" })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: " yes " })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: "on" })).toBe(false);
  });

  it("supports explicit true values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "1",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " true ",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "TRUE",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " yes ",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "ON",
        CI: "true",
      }),
    ).toBe(true);
  });

  it("supports explicit false values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "0",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " false ",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "FALSE",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " no ",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "OFF",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "0",
        CI: "true",
      }),
    ).toBe(false);
  });

  it("falls back to CI-based default for unknown values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "maybe",
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "maybe",
        CI: "false",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "maybe",
        CI: "ON",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " ",
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " ",
        CI: "false",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "unknown",
        CI: "maybe",
      }),
    ).toBe(true);
  });
});

describe("resolveBenchmarkFollowUpPassCount", () => {
  it("defaults to 1 outside CI", () => {
    expect(resolveBenchmarkFollowUpPassCount({ CI: "false" })).toBe(1);
    expect(resolveBenchmarkFollowUpPassCount({ CI: "0" })).toBe(1);
    expect(resolveBenchmarkFollowUpPassCount({ CI: "maybe" })).toBe(1);
    expect(resolveBenchmarkFollowUpPassCount({})).toBe(1);
  });

  it("defaults to 0 in CI", () => {
    expect(resolveBenchmarkFollowUpPassCount({ CI: "true" })).toBe(0);
    expect(resolveBenchmarkFollowUpPassCount({ CI: "on" })).toBe(0);
    expect(resolveBenchmarkFollowUpPassCount({ CI: " yes " })).toBe(0);
  });

  it("accepts explicit non-negative integer overrides", () => {
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "2",
        CI: "true",
      }),
    ).toBe(2);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: " 0 ",
        CI: "false",
      }),
    ).toBe(0);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "3",
        CI: "true",
      }),
    ).toBe(3);
  });

  it("caps explicit overrides to avoid runaway workload", () => {
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "5",
        CI: "false",
      }),
    ).toBe(5);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "6",
        CI: "false",
      }),
    ).toBe(5);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "99",
        CI: "false",
      }),
    ).toBe(5);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "99",
        CI: "true",
      }),
    ).toBe(5);
  });

  it("ignores malformed overrides and falls back to CI default", () => {
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "1abc",
        CI: "true",
      }),
    ).toBe(0);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "-1",
        CI: "false",
      }),
    ).toBe(1);
    expect(
      resolveBenchmarkFollowUpPassCount({
        T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES: "",
        CI: "true",
      }),
    ).toBe(0);
  });
});

describe("shouldRunOptionalRendererPerfInteractions", () => {
  it("defaults to enabled outside CI and disabled in CI", () => {
    expect(shouldRunOptionalRendererPerfInteractions({ CI: "false" })).toBe(true);
    expect(shouldRunOptionalRendererPerfInteractions({ CI: "true" })).toBe(false);
    expect(shouldRunOptionalRendererPerfInteractions({ CI: "ON" })).toBe(false);
  });

  it("supports explicit env overrides", () => {
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: "1",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: "off",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: " FALSE ",
        CI: "false",
      }),
    ).toBe(false);
  });

  it("falls back to CI default for unknown values", () => {
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: "maybe",
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: "maybe",
        CI: "false",
      }),
    ).toBe(true);
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: " ",
        CI: "true",
      }),
    ).toBe(false);
  });
});

describe("shouldRunBenchmarkThreadSweep", () => {
  it("defaults to enabled outside CI and disabled in CI", () => {
    expect(shouldRunBenchmarkThreadSweep({ CI: "false" })).toBe(true);
    expect(shouldRunBenchmarkThreadSweep({ CI: "true" })).toBe(false);
    expect(shouldRunBenchmarkThreadSweep({ CI: "ON" })).toBe(false);
  });

  it("supports explicit env overrides", () => {
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: "1",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: "off",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: "TRUE",
        CI: "true",
      }),
    ).toBe(true);
  });

  it("falls back to CI default for unknown values", () => {
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: "maybe",
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: "maybe",
        CI: "false",
      }),
    ).toBe(true);
  });
});

describe("toggle fallback consistency", () => {
  it("applies the same CI-aware fallback to all perf toggles", () => {
    const unknownValue = { value: "maybe" };

    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: unknownValue.value,
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: unknownValue.value,
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: unknownValue.value,
        CI: "true",
      }),
    ).toBe(false);

    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: unknownValue.value,
        CI: "false",
      }),
    ).toBe(true);
    expect(
      shouldRunOptionalRendererPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: unknownValue.value,
        CI: "false",
      }),
    ).toBe(true);
    expect(
      shouldRunBenchmarkThreadSweep({
        T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: unknownValue.value,
        CI: "false",
      }),
    ).toBe(true);
  });

  it("accepts the same explicit truthy aliases for all perf toggles", () => {
    const truthyAliases = ["1", "true", "TRUE", " yes ", "ON"];
    for (const value of truthyAliases) {
      expect(
        shouldRunTerminalPerfInteractions({
          T3CODE_DESKTOP_PERF_RUN_TERMINAL: value,
          CI: "true",
        }),
      ).toBe(true);
      expect(
        shouldRunOptionalRendererPerfInteractions({
          T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: value,
          CI: "true",
        }),
      ).toBe(true);
      expect(
        shouldRunBenchmarkThreadSweep({
          T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: value,
          CI: "true",
        }),
      ).toBe(true);
    }
  });

  it("accepts the same explicit falsy aliases for all perf toggles", () => {
    const falsyAliases = ["0", "false", "FALSE", " no ", "OFF"];
    for (const value of falsyAliases) {
      expect(
        shouldRunTerminalPerfInteractions({
          T3CODE_DESKTOP_PERF_RUN_TERMINAL: value,
          CI: "false",
        }),
      ).toBe(false);
      expect(
        shouldRunOptionalRendererPerfInteractions({
          T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: value,
          CI: "false",
        }),
      ).toBe(false);
      expect(
        shouldRunBenchmarkThreadSweep({
          T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: value,
          CI: "false",
        }),
      ).toBe(false);
    }
  });
});
