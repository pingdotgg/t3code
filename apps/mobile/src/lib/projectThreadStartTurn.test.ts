import { describe, expect, it, vi } from "vite-plus/test";

import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
vi.mock("./composerImages", () => ({
  toUploadChatImageAttachments: () => [],
}));

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

const ompProvider = {
  instanceId: ProviderInstanceId.make("omp_work"),
  driver: ProviderDriverKind.make("omp"),
  displayName: "Oh My Pi Work",
  showInteractionModeToggle: false,
  enabled: true,
  installed: true,
  version: "18.0.5",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-25T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function build(interactionMode: "default" | "plan", providers: ReadonlyArray<ServerProvider>) {
  return buildProjectThreadStartTurnInput({
    projectId: ProjectId.make("project-1"),
    projectCwd: "/tmp/project",
    threadId: "thread-1",
    commandId: "command-1",
    messageId: "message-1",
    createdAt: "2026-08-25T00:00:00.000Z",
    text: "Build this",
    attachments: [],
    modelSelection: { instanceId: ompProvider.instanceId, model: "default" },
    runtimeMode: "full-access",
    interactionMode,
    providers,
    workspaceMode: "local",
    branch: null,
    worktreePath: null,
    startFromOrigin: false,
    worktreeBranchName: "t3/temp",
  });
}

describe("buildProjectThreadStartTurnInput", () => {
  it("normalizes incapable provider Plan mode in command and bootstrap state", () => {
    const input = build("plan", [ompProvider]);
    expect(input.interactionMode).toBe("default");
    expect(input.bootstrap.createThread.interactionMode).toBe("default");
  });

  it("preserves Plan mode while provider capability is unknown", () => {
    const input = build("plan", []);
    expect(input.interactionMode).toBe("plan");
    expect(input.bootstrap.createThread.interactionMode).toBe("plan");
  });
});
