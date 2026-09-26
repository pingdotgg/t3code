import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, IssueKey } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironments } from "~/state/environments";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects } from "~/state/entities";
import { issueLinkEnvironment } from "~/state/issueLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveIssueProject, type StartableIssue, startThreadFromIssue } from "./issueLinks.logic";
import { environmentIdsWithCapability } from "./issueList.logic";

/**
 * "Start thread" on an Issue: a new thread in the project checked out from the Issue's
 * repository, in that project's usual worktree mode, linked at once, with the Issue waiting in
 * the composer for the user to send. `resolve` says which project, or why none.
 */
export function useStartThreadFromIssue() {
  const projects = useProjects();
  const newThread = useNewThreadHandler();
  const link = useAtomCommand(issueLinkEnvironment.link, { reportFailure: true });
  const { environments } = useEnvironments();
  // A project on a server that keeps Issue links, when there is one, so the thread links at once.
  const preferred = useMemo(() => {
    const keepsLinks = new Set(environmentIdsWithCapability(environments, "issueLinks"));
    return (project: { readonly environmentId: EnvironmentId }) =>
      keepsLinks.has(project.environmentId);
  }, [environments]);

  const resolve = useCallback(
    (issue: IssueKey) => resolveIssueProject(projects, issue, preferred),
    [preferred, projects],
  );

  const start = useCallback(
    (issue: StartableIssue) =>
      startThreadFromIssue(issue, {
        projects,
        preferred,
        openDraft: (project) => newThread(scopeProjectRef(project.environmentId, project.id)),
        writePrompt: (draftId, prompt) =>
          useComposerDraftStore.getState().setPrompt(draftId, prompt),
        link: (project, threadId, url) =>
          link({
            environmentId: project.environmentId,
            input: { threadId, target: { url }, source: "started" },
          }),
      }),
    [link, newThread, preferred, projects],
  );

  return { resolve, start };
}
