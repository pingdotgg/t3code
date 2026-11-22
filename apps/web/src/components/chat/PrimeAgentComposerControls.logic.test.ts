import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activePrimeAgentCommandInPrompt,
  applyPrimeAgentCommandToPrompt,
  formatPrimeAgentQuickCommand,
  shouldWarnPrimeAgentLocalHost,
} from "./PrimeAgentComposerControls.logic";

describe("PrimeAgentComposerControls logic", () => {
  it("formats /goal, /refine, and /autonomous with valid turn and token budgets", () => {
    expect(formatPrimeAgentQuickCommand("goal")).toBe("/goal");
    expect(formatPrimeAgentQuickCommand("refine")).toBe("/refine");
    expect(formatPrimeAgentQuickCommand("autonomous", { maxTurns: 20, maxTokens: 150_000 })).toBe(
      "/autonomous --max-turns 20 --max-tokens 150000",
    );
    expect(formatPrimeAgentQuickCommand("autonomous", { maxTurns: "0", maxTokens: "abc" })).toBe(
      "/autonomous",
    );
  });

  it("replaces an existing leading prime-agent slash command without dropping prompt body", () => {
    expect(applyPrimeAgentCommandToPrompt("Fix flaky test", "goal")).toBe("/goal Fix flaky test");
    expect(
      applyPrimeAgentCommandToPrompt("/goal Fix flaky test", "autonomous", {
        maxTurns: 15,
        maxTokens: 100_000,
      }),
    ).toBe("/autonomous --max-turns 15 --max-tokens 100000 Fix flaky test");
    expect(
      applyPrimeAgentCommandToPrompt(
        "/autonomous --max-turns 15 --max-tokens 100000 Fix flaky test",
        "refine",
      ),
    ).toBe("/refine Fix flaky test");
    expect(applyPrimeAgentCommandToPrompt("", "refine")).toBe("/refine");
    expect(applyPrimeAgentCommandToPrompt("", "goal")).toBe("/goal ");
  });

  it("detects active prime-agent command prefix in draft prompt", () => {
    expect(activePrimeAgentCommandInPrompt("/goal ship it")).toBe("goal");
    expect(activePrimeAgentCommandInPrompt("  /autonomous --max-turns 10 run")).toBe("autonomous");
    expect(activePrimeAgentCommandInPrompt("/refine")).toBe("refine");
    expect(activePrimeAgentCommandInPrompt("regular prompt")).toBeNull();
  });

  it("warns only when primeAgent runs on a non-cloud local host", () => {
    const primeAgent = ProviderDriverKind.make("primeAgent");
    const codex = ProviderDriverKind.make("codex");
    expect(shouldWarnPrimeAgentLocalHost({ provider: primeAgent, isCloudSandbox: false })).toBe(
      true,
    );
    expect(shouldWarnPrimeAgentLocalHost({ provider: primeAgent, isCloudSandbox: true })).toBe(
      false,
    );
    expect(shouldWarnPrimeAgentLocalHost({ provider: codex, isCloudSandbox: false })).toBe(false);
  });
});
