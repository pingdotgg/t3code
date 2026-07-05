import { describe, expect, it } from "vite-plus/test";
import { ProjectId, type ModelSelection } from "@t3tools/contracts";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

const MODEL_SELECTION: ModelSelection = {
  instanceId: "claude-code",
  model: "claude-fable-5",
} as ModelSelection;

function spec(overrides: Partial<ProjectThreadStartTurnSpec> = {}): ProjectThreadStartTurnSpec {
  return {
    projectId: ProjectId.make("project-1"),
    projectCwd: "/workspace/repo",
    threadId: "thread-1",
    commandId: "command-1",
    messageId: "message-1",
    createdAt: "2026-07-04T12:00:00.000Z",
    text: "Fix the flaky login test",
    attachments: [],
    modelSelection: MODEL_SELECTION,
    runtimeMode: "default" as ProjectThreadStartTurnSpec["runtimeMode"],
    interactionMode: "default" as ProjectThreadStartTurnSpec["interactionMode"],
    workspaceMode: "local",
    branch: null,
    worktreePath: null,
    startFromOrigin: false,
    worktreeBranchName: "tmp-branch",
    ...overrides,
  };
}

describe("buildProjectThreadStartTurnInput scene titles", () => {
  it("uses the prompt-derived title when no scene is set", () => {
    const input = buildProjectThreadStartTurnInput(spec());
    const derived = deriveThreadTitleFromPrompt("Fix the flaky login test");
    expect(input.bootstrap.createThread.title).toBe(derived);
    expect(input.titleSeed).toBe(derived);
  });

  it("titles the thread after the scene while keeping the prompt-derived seed", () => {
    const input = buildProjectThreadStartTurnInput(spec({ sceneTitle: "Seceda" }));
    // title !== titleSeed means the server's provider-title pass (which only
    // replaces titles equal to the seed or the default) keeps the scene name.
    expect(input.bootstrap.createThread.title).toBe("Seceda");
    expect(input.titleSeed).toBe(deriveThreadTitleFromPrompt("Fix the flaky login test"));
  });

  it("treats a null scene like no scene", () => {
    const input = buildProjectThreadStartTurnInput(spec({ sceneTitle: null }));
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
  });
});
