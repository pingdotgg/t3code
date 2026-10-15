import type { EnvironmentId, IssueRef, ScopedThreadRef } from "@t3tools/contracts";
import { pullRequestHostOf, SourceControlProviderKind } from "@t3tools/contracts";
import { parseIssueUrl, type IssueLink } from "@t3tools/shared/issueUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { type MouseEvent, useCallback } from "react";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useRightPanelStore } from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";

/** The host and scope a project's git-host tracker is bound to, the way the server resolves it. */
function projectIssueBinding(project: EnvironmentProject): {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
} | null {
  const identity = project.repositoryIdentity;
  const scope = sourceControlRepositorySelector(identity);
  const kind = identity?.provider;
  if (!identity || kind === undefined || kind === "unknown" || scope === null) return null;
  return {
    tracker: kind,
    host: pullRequestHostOf(identity, SourceControlProviderKind.make(kind)),
    scope: scope.toLowerCase(),
  };
}

/**
 * The reference an issue link resolves to, and the project it is read through: the project whose
 * tracker binding is that host and scope, else any project on the same tracker and host lending
 * its credentials for a read-only view. The same rule as the server's `IssueService.resolveUrl`,
 * applied here so a lookalike hostname matches no project and stays an ordinary link.
 */
function resolveIssueLinkTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  link: IssueLink,
  preferredProjectId?: string,
): { readonly project: EnvironmentProject; readonly ref: IssueRef } | null {
  const bound = projects.flatMap((project) => {
    const binding = projectIssueBinding(project);
    return binding === null || binding.tracker !== link.tracker || binding.host !== link.host
      ? []
      : [{ project, binding }];
  });
  const preferFirst = (candidates: typeof bound) =>
    candidates.find((candidate) => candidate.project.id === preferredProjectId) ?? candidates[0];
  const own = preferFirst(bound.filter((candidate) => candidate.binding.scope === link.scope));
  const lender = own ?? preferFirst(bound);
  if (lender === undefined) return null;
  return {
    project: lender.project,
    ref: {
      projectId: lender.project.id,
      tracker: lender.binding.tracker as IssueRef["tracker"],
      host: lender.binding.host,
      scope: own === undefined ? link.scope : lender.binding.scope,
      key: link.key,
    },
  };
}

/**
 * Opens an issue link beside the thread, and says whether it did. Anything else — a host no
 * project here is on, a link that merely looks like one — is left alone for the caller to handle
 * as the ordinary link it is. Mirrors `useOpenChangeRequestLink`: a reader following a link the
 * agent wrote is reading the thread, and should still be reading it afterwards.
 */
export function useOpenIssueLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  return useCallback(
    (event, targetUrl, targetEnvironmentId) => {
      if (event.metaKey || event.ctrlKey) return false;
      const resolvedPanelRef = panelRef ?? threadRef;
      const environmentId = resolvedPanelRef?.environmentId ?? targetEnvironmentId;
      if (resolvedPanelRef === undefined || environmentId === undefined) return false;
      if (serverConfigs.get(environmentId)?.environment.capabilities.issues !== true) return false;
      const parsed = parseIssueUrl(targetUrl);
      if (parsed === null) return false;
      const target = resolveIssueLinkTarget(
        allProjects.filter((project) => project.environmentId === environmentId),
        parsed,
      );
      if (target === null) return false;
      event.preventDefault();
      event.stopPropagation();
      useRightPanelStore.getState().openIssue(resolvedPanelRef, {
        ...(resolvedPanelRef.environmentId === environmentId ? {} : { environmentId }),
        projectId: target.ref.projectId,
        tracker: target.ref.tracker,
        ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
        scope: target.ref.scope,
        key: target.ref.key,
        url: targetUrl,
      });
      return true;
    },
    [allProjects, panelRef, serverConfigs, threadRef],
  );
}
