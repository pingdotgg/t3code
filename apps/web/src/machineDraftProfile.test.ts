import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  physicalProjectProfileKey,
  resolveMachineProfileSummary,
  type MachineDraftProfile,
} from "./machineDraftProfile";

const remoteEnvironmentId = EnvironmentId.make("env-remote");
const remoteProjectId = ProjectId.make("project-remote");
const codexInstanceId = ProviderInstanceId.make("codex");

const remoteModelSelection: ModelSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.4",
};

const remoteProfile: MachineDraftProfile = {
  environmentId: remoteEnvironmentId,
  projectId: remoteProjectId,
  branch: "feature/remote",
  worktreePath: "C:/repo/.t3/worktrees/remote",
  envMode: "worktree",
  startFromOrigin: true,
  runtimeMode: "approval-required",
  interactionMode: "plan",
  modelSelectionByProvider: { [codexInstanceId]: remoteModelSelection },
  activeProvider: codexInstanceId,
};

describe("machine draft profiles", () => {
  it("keys profiles by physical environment and project", () => {
    expect(physicalProjectProfileKey(remoteEnvironmentId, remoteProjectId)).toBe(
      "env-remote:project-remote",
    );
  });

  it("summarizes a saved profile without leaking another machine's path", () => {
    expect(
      resolveMachineProfileSummary({
        workspaceRoot: "C:/repo",
        defaultModelSelection: null,
        profile: remoteProfile,
      }),
    ).toMatchObject({
      branchLabel: "feature/remote",
      workspaceLabel: "C:/repo/.t3/worktrees/remote",
      modelLabel: "gpt-5.4",
      executionLabel: "Approval required · Plan · origin",
    });
  });

  it("falls back to physical project defaults on a first visit", () => {
    expect(
      resolveMachineProfileSummary({
        workspaceRoot: "C:/repo",
        defaultModelSelection: { instanceId: codexInstanceId, model: "sonnet" },
        profile: null,
      }),
    ).toMatchObject({
      branchLabel: "Current checkout",
      workspaceLabel: "Current checkout",
      modelLabel: "sonnet",
      executionLabel: "Project defaults",
    });
  });
});
