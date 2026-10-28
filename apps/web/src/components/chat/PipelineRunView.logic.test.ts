import type { ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { pipelineChildLiveState, pipelineStepModelLabel } from "./PipelineRunView.logic";

type LiveShell = Parameters<typeof pipelineChildLiveState>[0];

const shell = (overrides: Record<string, unknown>) =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    ...overrides,
  }) as unknown as LiveShell;

describe("pipelineChildLiveState", () => {
  it("is null without a shell or activity", () => {
    expect(pipelineChildLiveState(null)).toBeNull();
    expect(pipelineChildLiveState(shell({}))).toBeNull();
    expect(pipelineChildLiveState(shell({ runtime: { status: "idle" } }))).toBeNull();
  });

  it("prefers approvals, then input, then work", () => {
    const runtime = { status: "running" };
    expect(
      pipelineChildLiveState(
        shell({ hasPendingApprovals: true, hasPendingUserInput: true, runtime }),
      ),
    ).toBe("approval");
    expect(pipelineChildLiveState(shell({ hasPendingUserInput: true, runtime }))).toBe("input");
    expect(pipelineChildLiveState(shell({ runtime }))).toBe("working");
  });
});

describe("pipelineStepModelLabel", () => {
  const selection = { instanceId: "codex", model: "gpt-5" } as unknown as ModelSelection;

  it("falls back to the formatted slug when the provider is unknown", () => {
    const label = pipelineStepModelLabel(selection, []);
    expect(label.entry).toBeNull();
    expect(label.effort).toBeNull();
    expect(label.model.length).toBeGreaterThan(0);
  });

  it("uses the catalog name when the provider lists the model", () => {
    const entry = {
      instanceId: "codex",
      driverKind: "codex",
      models: [{ slug: "gpt-5", name: "Frontier Model", capabilities: null }],
    } as unknown as ProviderInstanceEntry;
    const label = pipelineStepModelLabel(selection, [entry]);
    expect(label.entry).toBe(entry);
    expect(label.model).toContain("Frontier Model");
    expect(label.effort).toBeNull();
  });
});
