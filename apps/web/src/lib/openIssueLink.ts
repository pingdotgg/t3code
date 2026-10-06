import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/shared/changeRequestUrl";
import { type MouseEvent, useCallback, useMemo } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import {
  findProjectOnChangeRequestHost,
  shouldOpenPullRequestExternally,
} from "./openPullRequestLink";

/**
 * Opens GitHub issue links beside the thread. Only beside a thread: the pull requests page has
 * no panel for issues, so there a link stays an ordinary link.
 *
 * `open` takes an issue link at its word. `openIfIssue` is for `#123` references, which GitHub
 * writes as `/issues/123` whether they name an issue, a pull request, or a discussion, so it asks
 * the host first and leaves anything but an issue to the caller.
 */
export function useOpenIssueLink(threadRef: ScopedThreadRef | undefined) {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const readIssue = useAtomQueryRunner(pullRequestEnvironment.issue, {
    reportFailure: false,
    reportDefect: false,
  });

  const resolve = useCallback(
    (
      targetUrl: string,
    ): {
      threadRef: ScopedThreadRef;
      input: { projectId: ProjectId; host: string; repository: string; number: number };
    } | null => {
      if (threadRef === undefined) return null;
      if (serverConfigs.get(threadRef.environmentId)?.environment.capabilities.issues !== true) {
        return null;
      }
      const parsed = parseIssueUrl(targetUrl);
      if (parsed === null) return null;
      const project = findProjectOnChangeRequestHost(
        projects.filter(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId &&
            candidate.repositoryIdentity?.provider === "github",
        ),
        parsed,
      );
      if (project === undefined) return null;
      return {
        threadRef,
        input: {
          projectId: project.id,
          host: parsed.host,
          repository: parsed.repository,
          number: parsed.number,
        },
      };
    },
    [projects, serverConfigs, threadRef],
  );

  return useMemo(() => {
    const show = (target: NonNullable<ReturnType<typeof resolve>>, url: string) =>
      useRightPanelStore.getState().openIssue(target.threadRef, { ...target.input, url });
    return {
      open: (
        event: Pick<
          MouseEvent<HTMLElement>,
          "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
        >,
        targetUrl: string,
      ): boolean => {
        if (shouldOpenPullRequestExternally(event)) return false;
        const target = resolve(targetUrl);
        if (target === null) return false;
        event.preventDefault();
        event.stopPropagation();
        show(target, targetUrl);
        return true;
      },
      openIfIssue: async (targetUrl: string): Promise<boolean> => {
        const target = resolve(targetUrl);
        if (target === null) return false;
        const result = await readIssue({
          environmentId: target.threadRef.environmentId,
          input: target.input,
        });
        if (result._tag !== "Success" || result.value._tag !== "issue") return false;
        show(target, targetUrl);
        return true;
      },
    };
  }, [readIssue, resolve]);
}
