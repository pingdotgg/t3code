import type { OllamaStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatBytes, ollamaStatusSummary, progressPercent } from "./LocalModelsSettings.logic";

const status = (overrides: Partial<OllamaStatus>): OllamaStatus => ({
  baseUrl: "http://127.0.0.1:11434",
  reachable: false,
  version: null,
  runtime: "none",
  managedInstalled: false,
  managedVersion: null,
  canInstall: true,
  agentIntegrationEnabled: false,
  ...overrides,
});

describe("local models settings", () => {
  it("formats sizes the way download pages show them", () => {
    expect(formatBytes(1_359_293_444)).toBe("1.4 GB");
    expect(formatBytes(19_000_000_000)).toBe("19 GB");
    expect(formatBytes(null)).toBe("-");
  });

  it("reports progress only when Ollama knows the total", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(10, null)).toBeNull();
    expect(progressPercent(300, 200)).toBe(100);
  });

  it("explains each Ollama state in plain words", () => {
    expect(ollamaStatusSummary(status({}))).toContain("Continuum can download and run it");
    expect(ollamaStatusSummary(status({ canInstall: false }))).toContain("ollama.com");
    expect(ollamaStatusSummary(status({ managedInstalled: true }))).toContain("not running");
    expect(
      ollamaStatusSummary(status({ reachable: true, version: "0.40.15", runtime: "managed" })),
    ).toBe("Ollama 0.40.15 is running at 127.0.0.1:11434, installed and started by Continuum.");
  });
});
