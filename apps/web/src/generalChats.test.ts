import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "./types";
import {
  excludeGeneralChatsProject,
  findGeneralChatsProject,
  GENERAL_CHAT_NEW_THREAD_OPTIONS,
  GENERAL_CHATS_PROJECT_ID,
  getGeneralChatNewThreadOptions,
  isGeneralChatsProjectAlreadyExistsError,
  isGeneralChatsProject,
  resolveGeneralChatNewThreadOptions,
} from "./generalChats";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("remote");

function makeProject(input: {
  readonly id: ProjectId;
  readonly environmentId?: EnvironmentId;
  readonly title?: string;
}): Project {
  return {
    id: input.id,
    environmentId: input.environmentId ?? LOCAL_ENVIRONMENT_ID,
    title: input.title ?? "Project",
    workspaceRoot: "/workspace",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("general chats project", () => {
  it("recognizes the reserved project id", () => {
    expect(isGeneralChatsProject(makeProject({ id: GENERAL_CHATS_PROJECT_ID }))).toBe(true);
    expect(isGeneralChatsProject(makeProject({ id: ProjectId.make("regular") }))).toBe(false);
  });

  it("finds chats only in the requested environment", () => {
    const localChats = makeProject({ id: GENERAL_CHATS_PROJECT_ID });
    const remoteChats = makeProject({
      id: GENERAL_CHATS_PROJECT_ID,
      environmentId: REMOTE_ENVIRONMENT_ID,
    });

    expect(findGeneralChatsProject([remoteChats, localChats], LOCAL_ENVIRONMENT_ID)).toBe(
      localChats,
    );
    expect(findGeneralChatsProject([localChats], REMOTE_ENVIRONMENT_ID)).toBeNull();
    expect(findGeneralChatsProject([localChats], null)).toBeNull();
  });

  it("keeps the reserved project out of normal project lists", () => {
    const regularProject = makeProject({ id: ProjectId.make("regular") });
    const chatsProject = makeProject({ id: GENERAL_CHATS_PROJECT_ID });

    expect(excludeGeneralChatsProject([chatsProject, regularProject])).toEqual([regularProject]);
  });

  it("forces replacement drafts for chats to stay local", () => {
    expect(getGeneralChatNewThreadOptions(GENERAL_CHATS_PROJECT_ID)).toBe(
      GENERAL_CHAT_NEW_THREAD_OPTIONS,
    );
    expect(getGeneralChatNewThreadOptions(ProjectId.make("regular"))).toBeUndefined();
    expect(GENERAL_CHAT_NEW_THREAD_OPTIONS).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
  });

  it("overrides contextual options for every new general chat", () => {
    expect(
      resolveGeneralChatNewThreadOptions(GENERAL_CHATS_PROJECT_ID, {
        branch: "feature/contextual-branch",
        worktreePath: "/workspace/contextual-worktree",
        envMode: "worktree",
        startFromOrigin: true,
      }),
    ).toEqual(GENERAL_CHAT_NEW_THREAD_OPTIONS);

    const regularOptions = { branch: "feature/regular", envMode: "worktree" } as const;
    expect(resolveGeneralChatNewThreadOptions(ProjectId.make("regular"), regularOptions)).toBe(
      regularOptions,
    );
  });

  it("recognizes only the exact duplicate general chats project invariant", () => {
    expect(
      isGeneralChatsProjectAlreadyExistsError({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "project.create",
        detail: `Project '${GENERAL_CHATS_PROJECT_ID}' already exists and cannot be created twice.`,
      }),
    ).toBe(true);
    expect(
      isGeneralChatsProjectAlreadyExistsError({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "project.create",
        detail: "Failed to create the workspace root.",
      }),
    ).toBe(false);
    expect(isGeneralChatsProjectAlreadyExistsError(new Error("already exists"))).toBe(false);
  });
});
