import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./uuid", () => ({
  uuidv4: () => "unused",
}));

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

const baseSpec = {
  projectId: ProjectId.make("project:t3-work"),
  projectCwd: "/private/t3-work",
  threadId: "thread:work",
  commandId: "command:work",
  messageId: "message:work",
  createdAt: "2026-07-26T00:00:00.000Z",
  text: "Summarize my messages",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("hermes-primary"),
    model: "default",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceMode: "local",
  branch: null,
  worktreePath: null,
  startFromOrigin: false,
  worktreeBranchName: "unused",
} as const;

describe("project thread start turn", () => {
  it("marks projectless Work launches to skip backing-project preparation", () => {
    const input = buildProjectThreadStartTurnInput({
      ...baseSpec,
      prepareWorkspace: false,
    });

    expect(input.bootstrap).toMatchObject({
      prepareWorkspace: false,
      createThread: {
        projectId: ProjectId.make("project:t3-work"),
        worktreePath: null,
      },
    });
    expect(input.bootstrap).not.toHaveProperty("prepareWorktree");
  });

  it("omits the workspace override for ordinary project launches", () => {
    expect(buildProjectThreadStartTurnInput(baseSpec).bootstrap).not.toHaveProperty(
      "prepareWorkspace",
    );
  });
});
