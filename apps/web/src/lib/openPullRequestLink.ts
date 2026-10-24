import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent } from "react";

import {
  findProjectForChangeRequest,
  resolvePullRequestPreviewTarget,
} from "@t3tools/client-runtime/change-request-links";
import {
  sourceControlClients,
  type ChangeRequestLink,
} from "@t3tools/client-runtime/source-control-clients";

import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, useProjects } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
    url,
  });
}

export function findProjectOnChangeRequestHost(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  const own = findProjectForChangeRequest(projects, link);
  if (own !== undefined) return own;
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    return (
      identity?.provider !== undefined &&
      sourceControlClients.get(identity.provider).canReadChangeRequestOnHost(identity, link)
    );
  });
}

function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
    if (!openInApp || shouldOpenPullRequestExternally(event)) return false;
    // Read at click time: every provider status push replaces the config map, and
    // subscribing would hand every rendered link a new handler. Projects likewise, so a
    // link can resolve against a snapshot that arrived after this handler was built.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const allProjects = readProjects();
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const resolvedPanelRef = panelRef ?? resolvedThreadRef;
    const parsed = sourceControlClients.parseChangeRequestUrl(targetUrl)?.link;
    if (parsed === undefined) return false;
    const reads = (environmentId: string) =>
      serverConfigs.get(environmentId as EnvironmentId)?.environment.capabilities.pullRequests ===
      true;
    // Beside a thread the panel reads on that thread's environment, so a project from another
    // one could not be read there whatever its remote says: two environments can hold the same
    // repository, and handing the panel the wrong one's id opens a surface that never loads.
    const projects = resolvedThreadRef
      ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
      : targetEnvironmentId
        ? allProjects.filter((project) => project.environmentId === targetEnvironmentId)
        : allProjects
            .filter((project) => reads(project.environmentId))
            .toSorted(
              (left, right) =>
                Number(right.environmentId === primaryEnvironmentId) -
                Number(left.environmentId === primaryEnvironmentId),
            );
    const exactProject = findProjectForChangeRequest(projects, parsed);
    const project =
      exactProject ??
      (resolvedPanelRef
        ? findProjectOnChangeRequestHost(
            projects.filter(
              (candidate) =>
                serverConfigs.get(candidate.environmentId)?.environment.capabilities
                  .threadPullRequests === true,
            ),
            parsed,
          )
        : undefined);
    if (project === undefined || !reads(project.environmentId)) return false;
    const repository =
      serverConfigs.get(project.environmentId)?.environment.capabilities.threadPullRequests === true
        ? parsed.repository
        : (sourceControlClients.repositorySelector(project.repositoryIdentity) ??
          parsed.repository);
    event.preventDefault();
    event.stopPropagation();
    if (resolvedPanelRef) {
      useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
        // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
        ...(resolvedPanelRef.environmentId === project.environmentId
          ? {}
          : { environmentId: project.environmentId }),
        projectId: project.id,
        ...(serverConfigs.get(project.environmentId)?.environment.capabilities
          .threadPullRequests === true
          ? { host: parsed.authority ?? parsed.host }
          : {}),
        repository,
        url: targetUrl,
        number: parsed.number,
      });
      if (!resolvedThreadRef) {
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            involvement: previous.involvement ?? "all",
            state: previous.state ?? "all",
            repository,
            number: parsed.number,
            selectedHost: parsed.authority ?? parsed.host,
            selectedProjectId: project.id,
            selectedEnvironmentId: project.environmentId,
          }),
          replace: true,
        });
      }
      return true;
    }
    void navigate({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository,
        number: parsed.number,
        selectedHost: parsed.authority ?? parsed.host,
        selectedProjectId: project.id,
        selectedEnvironmentId: project.environmentId,
      },
    });
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // A real link already knows how to cmd/ctrl/middle-click. Leave its default
    // action alone so the browser (or Electron's window-open handler) opens
    // the host. Buttons have no href, so they still go through openExternal.
    if (openInBrowser && isAnchor) return false;

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

    void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
    return false;
  };
}
