import { describe, expect, it } from "@effect/vitest";

import { ThreadId } from "./baseSchemas.ts";
import {
  CALM_HOST_PRESSURE,
  type HostPressure,
  hostPressureCulprit,
  hostPressureRanking,
} from "./resourceTelemetry.ts";

const heavy = ThreadId.make("thread-heavy");
const light = ThreadId.make("thread-light");
const loaded = (overrides: Partial<HostPressure>): HostPressure => ({
  ...CALM_HOST_PRESSURE,
  heaviestAgents: [{ threadId: heavy, agent: "codex", memoryBytes: 8_000_000_000, cpuCores: 3 }],
  ...overrides,
});

describe("hostPressureCulprit", () => {
  it("names a heaviest agent only while memory or CPU is severe", () => {
    expect(hostPressureCulprit(loaded({ memory: "severe" }), heavy)?.agent).toBe("codex");
    expect(hostPressureCulprit(loaded({ cpu: "severe" }), heavy)?.agent).toBe("codex");
    expect(hostPressureCulprit(loaded({ memory: "elevated" }), heavy)).toBeNull();
    // A full disk or slow storage is not any one agent's doing.
    expect(hostPressureCulprit(loaded({ disk: "severe", io: "severe" }), heavy)).toBeNull();
    expect(hostPressureCulprit(loaded({ memory: "severe" }), light)).toBeNull();
    expect(hostPressureCulprit(undefined, heavy)).toBeNull();
  });
});

describe("hostPressureRanking", () => {
  it("ranks by the more pressured resource, memory on a tie", () => {
    expect(hostPressureRanking(loaded({ memory: "elevated", cpu: "severe" }))).toBe("cpu");
    expect(hostPressureRanking(loaded({ memory: "severe", cpu: "elevated" }))).toBe("memory");
    expect(hostPressureRanking(loaded({ memory: "severe", cpu: "severe" }))).toBe("memory");
    expect(hostPressureRanking(loaded({ cpu: "elevated" }))).toBe("cpu");
  });
});
