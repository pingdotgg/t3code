import type { ModelSelection, PipelineRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  newerPipelineRun,
  pipelineChildLiveState,
  pipelineStepModelLabel,
  pipelineStepStatusDisplay,
} from "./PipelineRunView.logic";

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

describe("pipelineStepStatusDisplay", () => {
  it("shows one status: the thread's live state for a running step", () => {
    expect(pipelineStepStatusDisplay({ status: "running" }, "working")).toEqual({
      label: "Working",
      tone: "working",
    });
    expect(pipelineStepStatusDisplay({ status: "running" }, "approval")).toEqual({
      label: "Needs approval",
      tone: "attention",
    });
  });

  it("falls back to the step's own status", () => {
    expect(pipelineStepStatusDisplay({ status: "running" }, null)).toEqual({
      label: "Running",
      tone: "default",
    });
    expect(pipelineStepStatusDisplay({ status: "completed" }, "working")).toEqual({
      label: "Completed",
      tone: "default",
    });
  });

  it("flags an idle step whose turn ended without a handoff", () => {
    expect(pipelineStepStatusDisplay({ status: "running" }, null, true)).toEqual({
      label: "No handoff",
      tone: "attention",
    });
    // The thread working again (the user replied) outranks the pause.
    expect(pipelineStepStatusDisplay({ status: "running" }, "working", true)).toEqual({
      label: "Working",
      tone: "working",
    });
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

describe("newerPipelineRun", () => {
  const run = (id: string, updatedAt: string) => ({ id, updatedAt }) as unknown as PipelineRun;
  const live = run("r1", "2026-01-01T00:00:01.000Z");

  it("prefers the command result only while the subscription is behind", () => {
    expect(newerPipelineRun(live, null)).toBe(live);
    const ahead = run("r1", "2026-01-01T00:00:02.000Z");
    expect(newerPipelineRun(live, ahead)).toBe(ahead);
    expect(newerPipelineRun(ahead, live)).toBe(ahead);
    expect(newerPipelineRun(live, run("r2", "2026-01-01T00:00:09.000Z"))).toBe(live);
  });
});
