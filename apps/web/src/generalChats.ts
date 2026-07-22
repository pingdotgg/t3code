import {
  excludeGeneralChatsProject,
  GENERAL_CHATS_PROJECT_ID,
  GENERAL_CHATS_PROJECT_TITLE,
  GENERAL_CHATS_WORKSPACE_ROOT,
  isGeneralChatsProject,
} from "@t3tools/client-runtime/general-chats";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { DraftThreadEnvMode } from "./composerDraftStore";
import type { Project } from "./types";

export {
  excludeGeneralChatsProject,
  GENERAL_CHATS_PROJECT_ID,
  GENERAL_CHATS_PROJECT_TITLE,
  GENERAL_CHATS_WORKSPACE_ROOT,
  isGeneralChatsProject,
};
export const GENERAL_CHAT_NEW_THREAD_OPTIONS = {
  branch: null,
  worktreePath: null,
  envMode: "local",
  startFromOrigin: false,
} as const;

export interface GeneralChatNewThreadOptions {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly envMode?: DraftThreadEnvMode;
  readonly startFromOrigin?: boolean;
}

export function findGeneralChatsProject(
  projects: ReadonlyArray<Project>,
  environmentId: EnvironmentId | null,
): Project | null {
  if (environmentId === null) {
    return null;
  }

  return (
    projects.find(
      (project) => project.environmentId === environmentId && isGeneralChatsProject(project),
    ) ?? null
  );
}

export function getGeneralChatNewThreadOptions(projectId: ProjectId) {
  return projectId === GENERAL_CHATS_PROJECT_ID ? GENERAL_CHAT_NEW_THREAD_OPTIONS : undefined;
}

export function resolveGeneralChatNewThreadOptions(
  projectId: ProjectId,
  options?: GeneralChatNewThreadOptions,
): GeneralChatNewThreadOptions | undefined {
  const generalChatOptions = getGeneralChatNewThreadOptions(projectId);
  return generalChatOptions ? { ...options, ...generalChatOptions } : options;
}

export function isGeneralChatsProjectAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return (
    candidate._tag === "OrchestrationCommandInvariantError" &&
    candidate.commandType === "project.create" &&
    candidate.detail ===
      `Project '${GENERAL_CHATS_PROJECT_ID}' already exists and cannot be created twice.`
  );
}
