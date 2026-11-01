import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SkillEvalRunConfig,
  type SkillModelCell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../../providerInstances";
import {
  activeRunAction,
  evaluationCandidateForProject,
  formatCost,
  formatDuration,
  formatEffect,
  formatInterval,
  formatPValue,
  gatingLabel,
  runJudgeCallCount,
  runTrialCount,
} from "./skillsSettings.logic";

describe("skills settings statistical display", () => {
  it("keeps unavailable measurements unknown and formats uncertainty honestly", () => {
    expect(formatEffect(null)).toBe("unknown");
    expect(formatInterval(0.04, null)).toBe("unknown");
    expect(formatCost(null)).toBe("unknown");
    expect(formatCost(-0.00001)).toBe(formatCost(0));
    expect(formatDuration(null)).toBe("unknown");
    expect(formatEffect(0.125)).toBe("+12.5%");
    expect(formatInterval(-0.05, 0.2)).toBe("-5% to +20%");
    expect(formatPValue(0.0004)).toBe("<0.001");
    expect(formatPValue(0.0039)).toBe("0.004");
  });

  it("estimates trial turns and de-positioned judge calls from the run config", () => {
    const config = {
      taskIds: ["task-1", "task-2", "task-3"],
      arms: [
        { armId: "off", label: "Off", kind: "off", role: "control" },
        { armId: "base", label: "Base", kind: "base", role: "treatment" },
        { armId: "variant", label: "Variant", kind: "variant", role: "treatment" },
      ],
      repeats: 2,
      judgeSamples: 3,
    } as unknown as SkillEvalRunConfig;

    expect(runTrialCount(config)).toBe(18);
    expect(runJudgeCallCount(config)).toBe(72);
  });

  it("selects only a project-enabled ready provider that advertises the model", () => {
    const projectId = ProjectId.make("project:skills");
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const cell = { driver, model: "gpt-5.6-sol" } as SkillModelCell;
    const snapshot: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-29T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isCustom: false,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    };
    const ready = deriveProviderInstanceEntries([snapshot])[0];
    if (ready === undefined) throw new Error("Expected one provider entry.");
    const settings = { providerInstances: {}, projectSettingsOverrides: {} };

    expect(evaluationCandidateForProject(cell, [ready], settings, projectId)).toEqual({
      instanceId,
      model: "gpt-5.6-sol",
    });
    expect(
      evaluationCandidateForProject(cell, [{ ...ready, status: "warning" }], settings, projectId),
    ).toBeNull();
    expect(
      evaluationCandidateForProject(
        cell,
        [
          {
            ...ready,
            models: [
              {
                slug: "gpt-5.6-mini",
                name: "GPT-5.6 Mini",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
        settings,
        projectId,
      ),
    ).toBeNull();
    expect(
      evaluationCandidateForProject(
        cell,
        [ready],
        {
          ...settings,
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
          },
        },
        projectId,
      ),
    ).toBeNull();
  });

  it("labels native and best-effort gating distinctly", () => {
    expect(gatingLabel({ gating: "native" })).toBe("Hard gate");
    expect(gatingLabel({ gating: "instruction" })).toBe("Instruction (best effort)");
    expect(gatingLabel({ gating: "none" })).toBe("Not delivered");
  });

  it("offers the reverse run action for cancelled and interrupted runs", () => {
    expect(activeRunAction({ status: "running" })).toBe("cancel");
    expect(activeRunAction({ status: "cancelled" })).toBe("resume");
    expect(activeRunAction({ status: "interrupted" })).toBe("resume");
    expect(activeRunAction({ status: "completed" })).toBeNull();
  });
});
