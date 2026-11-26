import type {
  EnvironmentId,
  IssueTrackerConnectionList,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent } from "react";

import { readIssueListPreferences } from "../components/issue/issueListPreferences";
import { useClientSettings } from "../hooks/useSettings";
import { ISSUES_PANEL_REF, PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";

/**
 * Opens an issue link beside the thread, and says whether it did. Anything else — an unknown
 * host, a modifier click, or any link while "Open issues in T3 Code" is off — is left for the
 * caller to handle as an ordinary link. Mirrors `useOpenChangeRequestLink`.
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
  trackers?: IssueTrackerConnectionList,
) => boolean {
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const openInApp = useClientSettings((settings) => settings.issueLinksOpenInApp);
  return (event, targetUrl, targetEnvironmentId, trackers) => {
    if (!openInApp || event.metaKey || event.ctrlKey) return false;
    const resolvedPanelRef = panelRef ?? threadRef;
    // A list page's panel ref is a placeholder, not an environment; the link names its own.
    const environmentId = threadRef?.environmentId ?? targetEnvironmentId;
    if (resolvedPanelRef === undefined || environmentId === undefined) return false;
    if (serverConfigs.get(environmentId)?.environment.capabilities.issues !== true) return false;
    const target = resolveIssueLinkTarget({
      url: targetUrl,
      projects: allProjects.filter((project) => project.environmentId === environmentId),
      trackers,
    });
    if (target === null) return false;
    event.preventDefault();
    event.stopPropagation();
    const surface = {
      projectId: target.ref.projectId,
      tracker: target.ref.tracker,
      ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
      scope: target.ref.scope,
      key: target.ref.key,
      url: targetUrl,
    };
    // A list page's panel is the Issues page's: the pull request list's own panel shows pull
    // requests only. Opening the tab here, not only through the URL, also brings back one that
    // is already open.
    if (resolvedPanelRef === PULL_REQUESTS_PANEL_REF || resolvedPanelRef === ISSUES_PANEL_REF) {
      useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, { ...surface, environmentId });
      const selection = {
        selectedEnvironmentId: environmentId,
        selectedProjectId: target.ref.projectId,
        ...(target.ref.host === undefined ? {} : { selectedHost: target.ref.host }),
        tracker: target.ref.tracker,
        scope: target.ref.scope,
        key: target.ref.key,
      };
      // Already on the Issues page, the list keeps the filters it is showing.
      if (window.location.pathname === "/issues") {
        void navigate({
          from: "/issues",
          to: "/issues",
          search: (previous) => ({ ...previous, ...selection }),
        });
      } else {
        void navigate({ to: "/issues", search: { ...readIssueListPreferences(), ...selection } });
      }
      return true;
    }
    useRightPanelStore.getState().openIssue(resolvedPanelRef, {
      ...(resolvedPanelRef.environmentId === environmentId ? {} : { environmentId }),
      ...surface,
    });
    return true;
  };
}
