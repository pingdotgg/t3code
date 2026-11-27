import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  customOrchestrationModelProblem,
  resolveCustomOrchestrationModel,
} from "./customOrchestration.ts";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "model-a" };

const provider = (changes: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...changes,
});

const atLimit = (resetsAt: string): Partial<ServerProvider> => ({
  usageLimits: {
    checkedAt: "2026-01-01T00:00:00.000Z",
    windows: [{ id: "session", label: "Session", kind: "session", usedPercent: 100, resetsAt }],
  },
});

const problemKind = (changes: Partial<ServerProvider>, model = "model-a") =>
  customOrchestrationModelProblem(
    { ...selection, model },
    { providers: [provider(changes)], now: NOW },
  )?.kind ?? null;

describe("customOrchestrationModelProblem", () => {
  it.each([
    { label: "a ready provider", changes: {}, expected: null },
    { label: "a disabled provider", changes: { enabled: false }, expected: "provider" },
    {
      label: "a signed-out provider",
      changes: { auth: { status: "unauthenticated" as const } },
      expected: "provider",
    },
    {
      label: "a provider that failed its check",
      changes: { status: "error" as const },
      expected: "provider",
    },
    {
      label: "one failed check after a ready one",
      changes: { status: "error" as const, modelsRetained: true },
      expected: null,
    },
    {
      label: "a provider not checked yet",
      changes: {
        installed: false,
        status: "warning" as const,
        auth: { status: "unknown" as const },
      },
      expected: null,
    },
    {
      label: "a used-up limit",
      changes: atLimit("2026-01-01T01:00:00.000Z"),
      expected: "limit",
    },
    {
      label: "a limit that has since reset",
      changes: atLimit("2025-12-31T23:00:00.000Z"),
      expected: null,
    },
  ])("judges $label", ({ changes, expected }) => {
    expect(problemKind(changes)).toBe(expected);
  });

  it("reports a model its provider does not offer", () => {
    expect(problemKind({}, "model-b")).toBe("model");
    expect(problemKind({ models: [] }, "model-b")).toBeNull();
  });
});

describe("resolveCustomOrchestrationModel", () => {
  const model = (name: string) => ({ ...selection, model: name });
  const entry = { modelSelection: model("primary"), fallbacks: [model("first"), model("second")] };
  const resolve = (problems: Record<string, "provider" | "limit">) =>
    resolveCustomOrchestrationModel(entry, (candidate) => {
      const kind = problems[candidate.model];
      return kind === undefined ? null : { kind };
    }).selection?.model ?? null;

  it("takes the first model that can run, in the configured order", () => {
    expect(resolve({})).toBe("primary");
    expect(resolve({ primary: "limit", first: "provider" })).toBe("second");
  });

  it("with none able to run, keeps one that only waits on its limit", () => {
    expect(resolve({ primary: "provider", first: "limit", second: "provider" })).toBe("first");
    expect(resolve({ primary: "provider", first: "provider", second: "provider" })).toBeNull();
  });
});
