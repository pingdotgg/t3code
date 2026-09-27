import type { EnvironmentId } from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import {
  canOpenLinksInApp,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "~/browser/browserLinkTarget";
import { issueDetail } from "~/state/issues";
import { useProjects, useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  browserMayBlockNewTab,
  issueLinkCandidate,
  openIssueOrPullRequestLink,
} from "./issueLinkOpening.logic";

const NO_MODIFIER = {
  metaKey: false,
  ctrlKey: false,
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
};

function reportFailure(error: unknown) {
  console.error("[issue-link] failed to open link", error);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Unable to open link",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Opens the Issues page with an Issue's side panel, read through the given server. */
export function useOpenIssueInIssuesView() {
  const navigate = useNavigate();
  return useCallback(
    (url: string, environmentId: EnvironmentId) =>
      void navigate({
        to: "/pull-requests",
        search: {
          ...readPullRequestListPreferences(),
          view: "issues",
          issue: url,
          selectedEnvironmentId: environmentId,
        },
      }),
    [navigate],
  );
}

/**
 * Opens a GitHub `/issues/N` link in the app: the pull request panel when N is a pull request,
 * the Issues side panel when it is an Issue, the browser otherwise. Returns null, doing nothing,
 * for any other link. Both reads happen on click, never on render.
 */
export function useOpenIssueOrPullRequestLink(
  openChangeRequestLink: (
    event: typeof NO_MODIFIER,
    url: string,
    threadRef: undefined,
    environmentId: EnvironmentId | undefined,
  ) => boolean,
  openLink: (url: string) => Promise<void>,
  /** `openLink` opens beside a thread, so the in-app browser can take the link. */
  hasThread: boolean,
) {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const openIssue = useOpenIssueInIssuesView();
  const readPullRequest = useAtomQueryRunner(pullRequestEnvironment.preview, {
    reportFailure: false,
    reportDefect: false,
  });
  // The same query the side panel renders, so an Issue read here is not read again there.
  const readIssue = useAtomQueryRunner(issueDetail, { reportFailure: false, reportDefect: false });
  // A repeat click while a link is being read joins that read instead of opening it twice.
  const pending = useRef(new Map<string, Promise<unknown>>());
  return useCallback(
    (
      url: string,
      environmentId: EnvironmentId | null,
      options?: {
        /** The caller already read N as a pull request and it was none. */
        readonly pullRequestRead?: boolean;
      },
    ): Promise<unknown> | null => {
      const capabilities =
        environmentId === null
          ? undefined
          : serverConfigs.get(environmentId)?.environment.capabilities;
      const candidate = issueLinkCandidate({
        url,
        environmentId,
        projects,
        pullRequests: capabilities?.pullRequests === true,
        threadPullRequests: capabilities?.threadPullRequests === true,
      });
      const issue = parseIssueUrl(url);
      if (candidate === null || issue === null) return null;
      const inFlight = pending.current.get(url);
      if (inFlight !== undefined) return inFlight;
      const pullRequestTarget = options?.pullRequestRead ? null : candidate.pullRequestTarget;
      const opening = openIssueOrPullRequestLink({
        readPullRequest:
          pullRequestTarget === null
            ? null
            : async () => {
                const result = await readPullRequest(pullRequestTarget);
                return result._tag === "Success" ? result.value.url : null;
              },
        openPullRequest: (pullRequestUrl) =>
          openChangeRequestLink(NO_MODIFIER, pullRequestUrl, undefined, environmentId ?? undefined),
        readIssue:
          environmentId === null || capabilities?.issues !== true
            ? null
            : async () => (await readIssue({ environmentId, input: issue }))._tag === "Success",
        openIssue: () => environmentId !== null && openIssue(url, environmentId),
        openExternal: async () => {
          const linkTarget = resolveLinkTarget({
            url,
            event: NO_MODIFIER,
            // `openLink` reads the setting again and reports a failed read itself.
            preference: await resolveBrowserLinkTargetPreference().catch(() => "system" as const),
            canOpenInApp: canOpenLinksInApp(hasThread),
          });
          if (
            !browserMayBlockNewTab({
              desktop: Boolean(window.desktopBridge),
              linkTarget,
              userActivationActive: navigator.userActivation?.isActive,
            })
          ) {
            return openLink(url);
          }
          // The browser would block the tab silently, so the user opens it with a fresh click.
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Open this link on GitHub?",
              description: url,
              actionProps: {
                children: "Open on GitHub",
                onClick: () => void openLink(url).catch(reportFailure),
              },
            }),
          );
        },
      })
        .catch(reportFailure)
        .finally(() => pending.current.delete(url));
      pending.current.set(url, opening);
      return opening;
    },
    [
      hasThread,
      openChangeRequestLink,
      openIssue,
      openLink,
      projects,
      readIssue,
      readPullRequest,
      serverConfigs,
    ],
  );
}
