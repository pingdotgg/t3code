import { EnvironmentId, ProjectId, type ProjectKind } from "@t3tools/contracts";

import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";

/** Sentinel project id for local chat drafts. The server ignores this and mints the synthetic chat project itself. */
export const CHAT_DRAFT_PROJECT_ID = ProjectId.make("chat");

export function chatLogicalProjectKey(environmentId: EnvironmentId): string {
  return scopedProjectKey(scopeProjectRef(environmentId, CHAT_DRAFT_PROJECT_ID));
}

export function projectHasWorkspace(
  project: { readonly kind?: ProjectKind } | null | undefined,
): boolean {
  return project != null && project.kind !== "chat";
}

/** Chat projects are omitted from the client-visible shell. */
export function isVisibleShellProject(project: { readonly kind?: ProjectKind }): boolean {
  return project.kind !== "chat";
}

export function isChatDraft(
  draft: { readonly createInChatScratch?: boolean } | null | undefined,
): boolean {
  return draft?.createInChatScratch === true;
}

function threadProjectIsVisible(input: {
  readonly thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      }
    | null
    | undefined;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
}): boolean {
  return (
    input.thread != null &&
    input.projects.some(
      (project) =>
        project.environmentId === input.thread!.environmentId &&
        project.id === input.thread!.projectId,
    )
  );
}

/**
 * True only when the thread's project is already in the visible (non-chat)
 * projects list. Loading state and hidden chat projects both return false, so
 * callers that inherit a project for "New thread" never target the synthetic
 * chat project.
 */
export function isWorkspaceThread(input: {
  readonly thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      }
    | null
    | undefined;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
}): boolean {
  return threadProjectIsVisible(input);
}

/**
 * Chat threads live under a hidden synthetic project, so they are the ones
 * whose `projectId` is missing from the visible (non-chat) projects list.
 * Until that environment's shell has bootstrapped, missing projects are
 * loading state — not chats.
 */
export function isChatThread(input: {
  readonly thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      }
    | null
    | undefined;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  readonly projectsKnown: boolean;
}): boolean {
  if (!input.projectsKnown || input.thread == null) {
    return false;
  }
  return !threadProjectIsVisible(input);
}
