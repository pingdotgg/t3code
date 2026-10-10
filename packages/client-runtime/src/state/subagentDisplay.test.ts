import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { OrchestrationV2TurnItemStatus, ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  subagentGroupSummary,
  resolveSubagentMetadata,
  resolveSubagentModelTraits,
  subagentDetailPreview,
} from "./subagentDisplay.js";

describe("subagentGroupSummary", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "keeps a mixed group live while a member is %s",
    (status) => {
      expect(subagentGroupSummary([{ status: "completed" }, { status }])).toEqual({
        label: "Kicked off 2 subagents",
        active: true,
        failed: false,
      });
    },
  );

  it("settles the label without disguising a failed member as success", () => {
    const statuses: OrchestrationV2TurnItemStatus[] = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    expect(subagentGroupSummary(statuses.map((status) => ({ status })))).toEqual({
      label: "Ran 4 subagents",
      active: false,
      failed: true,
    });
  });

  it("uses a singular label for one idle member", () => {
    expect(subagentGroupSummary([{ status: "idle" }])).toEqual({
      label: "Ran 1 subagent",
      active: false,
      failed: false,
    });
  });
});

describe("resolveSubagentMetadata", () => {
  it("resolves provider aliases to catalog names, including custom models", () => {
    expect(
      resolveSubagentMetadata({
        model: "claude-haiku-4-5-20251001",
        provider: {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [
            {
              slug: "claude-haiku-4-5",
              name: "Claude Haiku 4.5",
              shortName: "Haiku 4.5",
              aliases: ["claude-haiku-4-5-20251001"],
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("Haiku 4.5");
    expect(
      resolveSubagentMetadata({
        model: "my-model",
        provider: {
          driver: ProviderDriverKind.make("acpRegistry"),
          models: [
            {
              slug: "my-model",
              name: "Cloud+ / My custom model",
              subProvider: "Cloud+",
              isCustom: true,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("My custom model");
  });

  it("keeps unknown model identities and does not invent an unreported model", () => {
    expect(resolveSubagentMetadata({ model: " custom/model " }).modelLabel).toBe("custom/model");
    expect(
      resolveSubagentMetadata({
        model: null,
        provider: { driver: ProviderDriverKind.make("codex"), models: [] },
      }).modelLabel,
    ).toBe("Not reported");
    expect(resolveSubagentMetadata({ model: " " }).modelLabel).toBe("Not reported");
  });

  const parentThread = { projectId: ProjectId.make("parent"), worktreePath: null };
  const parentProject = { workspaceRoot: "/repo" };

  it("shows another project and its branch when the child has a different workspace", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "fix/agents", worktreePath: "/worktrees/agents" },
        childProject: {
          id: ProjectId.make("child"),
          title: "Other project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([
      { label: "Project", value: "Other project" },
      { label: "Branch", value: "fix/agents" },
    ]);
  });

  it("labels a detached worktree or another project workspace without a branch", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: null, worktreePath: "/worktrees/agents" },
      }).workspace,
    ).toEqual([{ label: "Worktree", value: "agents" }]);
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childProject: {
          id: parentThread.projectId,
          title: "Same project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([{ label: "Workspace", value: "other" }]);
  });

  it("hides redundant workspace metadata and tolerates unavailable child shells", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "main", worktreePath: "/repo" },
        childProject: { id: parentThread.projectId, title: "Same project", workspaceRoot: "/repo" },
      }).workspace,
    ).toEqual([]);
    expect(resolveSubagentMetadata({ model: null, parentThread, parentProject }).workspace).toEqual(
      [],
    );
  });
});

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});

describe("resolveSubagentModelTraits", () => {
  const claudeInstance = ProviderInstanceId.make("claude");
  const codexInstance = ProviderInstanceId.make("codex");
  const effort = {
    id: "effort",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra High" },
    ],
  };
  const claude = (extra: ReadonlyArray<ProviderOptionDescriptor> = []) => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      {
        slug: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        aliases: ["claude-opus-4-7-20260101"],
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            effort,
            { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
            ...extra,
          ],
        },
      },
    ],
  });
  const codex = (tiers: ReadonlyArray<{ id: string; label: string }>) => ({
    driver: ProviderDriverKind.make("codex"),
    models: [
      {
        slug: "gpt-6.1-sol",
        name: "GPT-6.1-Sol",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            { ...effort, id: "reasoningEffort" },
            { id: "serviceTier", label: "Service Tier", type: "select" as const, options: tiers },
          ],
        },
      },
    ],
  });
  const codexTiers = [
    { id: "default", label: "Standard" },
    { id: "priority", label: "Fast" },
  ];
  const selection = (
    instanceId: ProviderInstanceId,
    model: string,
    options: ReadonlyArray<{ id: string; value: string | boolean }>,
  ) => ({ instanceId, model, options });

  it("falls back to an app-owned child's selection but not a provider-native one's", () => {
    const traits = (origin: "app_owned" | "provider_native") =>
      resolveSubagentModelTraits({
        model: "claude-opus-4-7-20260101",
        providerInstanceId: claudeInstance,
        origin,
        childThread: {
          modelSelection: selection(claudeInstance, "claude-opus-4-7", [
            { id: "effort", value: "xhigh" },
            { id: "fastMode", value: true },
          ]),
        },
        provider: claude(),
      });
    expect(traits("app_owned")).toEqual({ effortLabel: "Extra High", speed: "fast" });
    expect(traits("provider_native")).toEqual({ effortLabel: null, speed: null });
  });

  it("prefers the subagent's own selection over its child thread's", () => {
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "app_owned",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", [
          { id: "effort", value: "high" },
          { id: "fastMode", value: false },
        ]),
        childThread: {
          modelSelection: selection(claudeInstance, "claude-opus-4-7", [
            { id: "effort", value: "xhigh" },
            { id: "fastMode", value: true },
          ]),
        },
        provider: claude(),
      }),
    ).toEqual({ effortLabel: "High", speed: null });
  });

  it("calls out a Codex fast tier and leaves the standard tier unmarked", () => {
    const traits = (tier: string) =>
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: codexInstance,
        origin: "provider_native",
        modelSelection: selection(codexInstance, "gpt-6.1-sol", [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: tier },
        ]),
        provider: codex(codexTiers),
      });
    expect(traits("priority")).toEqual({ effortLabel: "High", speed: "fast" });
    expect(traits("default")).toEqual({ effortLabel: "High", speed: null });
  });

  it("finds a fast tier that shares its id with the standard choice", () => {
    expect(
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: codexInstance,
        origin: "provider_native",
        modelSelection: selection(codexInstance, "gpt-6.1-sol", [
          { id: "serviceTier", value: "default" },
        ]),
        provider: codex([
          { id: "default", label: "Standard" },
          { id: "default", label: "Fast" },
        ]),
      }).speed,
    ).toBe("fast");
  });

  it("claims no speed the provider does not run", () => {
    // Claude ignores service tiers, and a tier the catalog does not list is unknown.
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", [
          { id: "serviceTier", value: "priority" },
        ]),
        provider: claude([
          { id: "serviceTier", label: "Speed", type: "select", options: codexTiers },
        ]),
      }).speed,
    ).toBeNull();
    expect(
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: codexInstance,
        origin: "provider_native",
        modelSelection: selection(codexInstance, "gpt-6.1-sol", [
          { id: "serviceTier", value: "Fast" },
        ]),
        provider: codex(codexTiers),
      }).speed,
    ).toBeNull();
  });

  it("ignores a selection for another model or provider instance", () => {
    const options = [
      { id: "effort", value: "xhigh" },
      { id: "fastMode", value: true },
    ];
    expect(
      resolveSubagentModelTraits({
        model: "claude-haiku-4-5",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", options),
        provider: claude(),
      }),
    ).toEqual({ effortLabel: null, speed: null });
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(
          ProviderInstanceId.make("claude-work"),
          "claude-opus-4-7",
          options,
        ),
        provider: claude(),
      }),
    ).toEqual({ effortLabel: null, speed: null });
  });
});
