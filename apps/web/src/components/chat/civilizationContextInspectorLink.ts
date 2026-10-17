import type { EnvironmentId, ProjectId, RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export interface CivilizationContextSettingsLinkSearch {
  readonly project: string;
  readonly machine: EnvironmentId;
  readonly checkout: string;
  readonly contextThread: ThreadId;
  readonly contextRun: RunId;
  readonly contextAttempt: RunAttemptId;
  readonly contextTurn: number;
}

/** Exact physical Settings target for one historical provider-turn inspection. */
export function resolveCivilizationContextSettingsLink(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerTurnOrdinal: number;
}): CivilizationContextSettingsLinkSearch | null {
  if (!Number.isSafeInteger(input.providerTurnOrdinal) || input.providerTurnOrdinal < 1)
    return null;
  for (const group of input.groups) {
    const member = group.memberProjects.find(
      (candidate) =>
        candidate.environmentId === input.environmentId && candidate.id === input.projectId,
    );
    if (member === undefined) continue;
    return {
      project: group.projectKey,
      machine: input.environmentId,
      checkout: member.physicalProjectKey,
      contextThread: input.threadId,
      contextRun: input.runId,
      contextAttempt: input.attemptId,
      contextTurn: input.providerTurnOrdinal,
    };
  }
  return null;
}
