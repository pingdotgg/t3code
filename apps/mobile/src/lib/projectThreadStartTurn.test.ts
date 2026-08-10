import { describe, expect, it, vi } from "vite-plus/test";

import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";

vi.mock("./uuid", () => ({
  randomHex: () => "deadbeef",
}));

import {
  buildProjectThreadStartTurnInput,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

const makeSpec = (
  overrides: Partial<ProjectThreadStartTurnSpec> = {},
): ProjectThreadStartTurnSpec => ({
  projectId: ProjectId.make("project-1"),
  projectCwd: "/workspace/project-1",
  threadId: "thread-1",
  commandId: "command-1",
  messageId: "message-1",
  createdAt: "2026-08-10T12:00:00.000Z",
  text: "Build the mobile change",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceMode: "worktree",
  branch: "main",
  worktreePath: null,
  startFromOrigin: false,
  ...overrides,
});

describe("buildProjectThreadStartTurnInput", () => {
  it("uses the configured prefix for a worktree bootstrap branch", () => {
    const input = buildProjectThreadStartTurnInput(
      makeSpec({
        worktreeBranchPrefix: "mobile-team",
      }),
    );

    expect(input.bootstrap.prepareWorktree?.branch).toBe("mobile-team/deadbeef");
  });

  it("falls back to the default prefix when the server configuration is unavailable", () => {
    const input = buildProjectThreadStartTurnInput(makeSpec());

    expect(input.bootstrap.prepareWorktree?.branch).toBe("t3code/deadbeef");
  });

  it("omits worktree preparation for a local thread", () => {
    const input = buildProjectThreadStartTurnInput(
      makeSpec({
        workspaceMode: "local",
        worktreePath: "/workspace/project-1",
      }),
    );

    expect(input.bootstrap.prepareWorktree).toBeUndefined();
  });
});
