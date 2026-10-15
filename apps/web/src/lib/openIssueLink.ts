import { pullRequestHostOf, SourceControlProviderKind } from "@t3tools/contracts";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback } from "react";

import {
  canOpenLinksInApp,
  resolveBrowserLinkTargetPreference,
} from "../browser/browserLinkTarget";
import { useOpenLink } from "../browser/useOpenLink";
import { readIssueListPreferences } from "../components/issue/issueListPreferences";
import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { ISSUES_PANEL_REF, useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects, useServerConfigs } from "../state/entities";
import { issueEnvironment } from "../state/issues";
import { useAtomCommand } from "../state/use-atom-command";

async function openUnresolvedLink(url: string): Promise<void> {
  if (window.desktopBridge) return readLocalApi()?.shell.openExternal(url);
  const opened = window.open("", "_blank");
  if (!opened) throw new Error("The browser blocked the link.");
  opened.opener = null;
  opened.location.href = url;
}

export function useOpenIssueLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  targetUrl: string,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  const openLink = useOpenLink(threadRef);
  const resolveUrl = useAtomCommand(issueEnvironment.resolveUrl, { reportFailure: false });
  return useCallback(
    (event, targetUrl, targetEnvironmentId) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
      const resolvedPanelRef = threadRef ?? (panelRef && ISSUES_PANEL_REF);
      const environmentId = targetEnvironmentId ?? threadRef?.environmentId;
      if (resolvedPanelRef === undefined || environmentId === undefined) return false;
      if (serverConfigs.get(environmentId)?.environment.capabilities.issues !== true) return false;
      const candidate =
        parseIssueUrl(targetUrl) !== null ||
        projects.some((project) => {
          const identity = project.repositoryIdentity;
          const tracker = identity?.provider;
          if (
            project.environmentId !== environmentId ||
            tracker === undefined ||
            tracker === "unknown"
          )
            return false;
          const kind = SourceControlProviderKind.make(tracker);
          let host = pullRequestHostOf(identity, kind);
          if (tracker === "forgejo" && identity?.webUrl !== undefined) {
            host = pullRequestHostOf(
              { canonicalKey: host, locator: { remoteUrl: identity.webUrl } },
              kind,
            );
          }
          return parseIssueUrl(targetUrl, { tracker, host }) !== null;
        });
      if (!candidate) return false;
      event.preventDefault();
      event.stopPropagation();
      const projectId =
        threadRef?.environmentId === environmentId
          ? readThreadShell(threadRef)?.projectId
          : undefined;
      void resolveUrl({
        environmentId,
        input: {
          url: targetUrl,
          ...(projectId === undefined ? {} : { projectId }),
        },
      })
        .then(async (result) => {
          if (result._tag === "Failure") {
            return canOpenLinksInApp(threadRef) &&
              (await resolveBrowserLinkTargetPreference()) === "app"
              ? openLink(targetUrl)
              : openUnresolvedLink(targetUrl);
          }
          const reference = result.value;
          useRightPanelStore.getState().openIssue(resolvedPanelRef, {
            ...(resolvedPanelRef.environmentId === environmentId ? {} : { environmentId }),
            projectId: reference.projectId,
            tracker: reference.tracker,
            host: reference.host,
            scope: reference.scope,
            key: reference.key,
            url: targetUrl,
          });
          if (threadRef === undefined) {
            await navigate({
              to: "/issues",
              search: {
                ...readIssueListPreferences(),
                selectedEnvironmentId: environmentId,
                selectedProjectId: reference.projectId,
                ...(reference.host === undefined ? {} : { selectedHost: reference.host }),
                tracker: reference.tracker,
                scope: reference.scope,
                key: reference.key,
              },
            });
          }
        })
        .catch(() => {
          const id = toastManager.add({
            type: "error",
            title: "The link could not be opened",
            description: targetUrl,
            actionProps: {
              children: "Open link",
              onClick: () =>
                void openUnresolvedLink(targetUrl).then(
                  () => toastManager.close(id),
                  () => undefined,
                ),
            },
          });
        });
      return true;
    },
    [navigate, openLink, panelRef, projects, resolveUrl, serverConfigs, threadRef],
  );
}
