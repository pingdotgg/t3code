import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  normalizeProviderInteractionMode,
  selectedProviderShowsInteractionModeToggle,
} from "./providerCapabilities.ts";

function provider(instanceId: string, showInteractionModeToggle?: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId === "omp_work" ? "omp" : instanceId),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-25T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(showInteractionModeToggle === undefined ? {} : { showInteractionModeToggle }),
  };
}

describe("provider capabilities", () => {
  it("normalizes Plan only for the selected incapable instance", () => {
    const providers = [provider("codex", true), provider("omp_work", false)];
    const omp = { instanceId: ProviderInstanceId.make("omp_work") };
    const codex = { instanceId: ProviderInstanceId.make("codex") };

    expect(selectedProviderShowsInteractionModeToggle(providers, omp)).toBe(false);
    expect(normalizeProviderInteractionMode(providers, omp, "plan")).toBe("default");
    expect(normalizeProviderInteractionMode(providers, codex, "plan")).toBe("plan");
    expect(normalizeProviderInteractionMode(providers, omp, "default")).toBe("default");
  });

  it("preserves current behavior until the selected snapshot is available", () => {
    const missing = { instanceId: ProviderInstanceId.make("missing") };
    expect(selectedProviderShowsInteractionModeToggle([], missing)).toBe(true);
    expect(normalizeProviderInteractionMode([], missing, "plan")).toBe("plan");
    expect(selectedProviderShowsInteractionModeToggle([], null)).toBe(true);
  });
});
