import { useMemo } from "react";
import {
  normalizeWorkItemLinkKey,
  type EnvironmentId,
  type IssueRef,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import {
  linearProjectForTeam,
  linkIssuePreviewMatchesReference,
  resolveLinkIssueInput,
} from "~/components/pullRequest/LinkPullRequestDialog";
import { findProjectForIssue, repositoryForProjectLink } from "~/lib/openIssueLink";
import { readThreadShell, useProjects, useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export function resolveIssueUrl(input: {
  readonly url: string;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threadProjectId: ProjectId | null;
  readonly linearBindings:
    | Readonly<Record<ProjectId, { readonly repository: string } | null>>
    | undefined;
}) {
  return resolveLinkIssueInput({
    reference: input.url,
    project: null,
    findProject: (link) => {
      const project = findProjectForIssue(input.projects, link);
      return project === undefined
        ? undefined
        : { id: project.id, repository: repositoryForProjectLink(project, link.repository) };
    },
    linearProjectId: (team) =>
      linearProjectForTeam({
        team,
        projects: input.projects,
        currentProjectId: input.threadProjectId,
        bindings: input.linearBindings,
      }),
  });
}

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : null);

const savedIssueRef = (url: string) => {
  const parsed = resolveLinkIssueInput({
    reference: url,
    project: null,
    findProject: (link) => ({ id: "" as ProjectId, repository: link.repository }),
    linearProjectId: () => "" as ProjectId,
  });
  return parsed !== null && "issue" in parsed ? parsed.issue : null;
};

const sameRepository = (link: ThreadIssueLink, repository: string) => {
  const saved = link.repository.toLowerCase();
  const requested = repository.toLowerCase();
  return (
    saved === requested || (link.provider === "azure-devops" && saved.startsWith(`${requested}/`))
  );
};

export function findThreadIssueLink<T extends ThreadIssueLink>(
  links: ReadonlyArray<T>,
  url: string,
  ref: IssueRef | null,
): T | null {
  const host = hostOf(url);
  return (
    links.find(
      (link) =>
        normalizeWorkItemLinkKey({ provider: link.provider, url }).url ===
          normalizeWorkItemLinkKey(link).url ||
        (ref !== null &&
          host !== null &&
          link.number === ref.number &&
          (ref.provider === undefined || link.provider === ref.provider) &&
          hostOf(link.url) === host &&
          sameRepository(link, ref.repository) &&
          linkIssuePreviewMatchesReference(url, link)),
    ) ?? null
  );
}

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
  throw squashAtomCommandFailure(result);
}

export function useIssueLinking(environmentId: EnvironmentId | null | undefined) {
  const configs = useServerConfigs();
  const projects = useProjects();
  const config = environmentId == null ? undefined : configs.get(environmentId);
  const supported = config?.environment.capabilities.issues === true;
  const linearBindings = config?.settings.issueTracking.connections.linear?.projectBindings;
  const readDetail = useAtomQueryRunner(issueEnvironment.detail, {
    reportFailure: false,
    reportDefect: false,
  });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  return useMemo(() => {
    const environmentProjects = projects.filter(
      (project) => project.environmentId === environmentId,
    );
    const resolve = (threadRef: ScopedThreadRef, url: string) =>
      supported && threadRef.environmentId === environmentId
        ? resolveIssueUrl({
            url,
            projects: environmentProjects,
            threadProjectId: readThreadShell(threadRef)?.projectId ?? null,
            linearBindings,
          })
        : null;
    const canLink = (threadRef: ScopedThreadRef, url: string) => {
      const resolved = resolve(threadRef, url);
      return resolved !== null && "issue" in resolved;
    };
    const linkedIssueFor = (threadRef: ScopedThreadRef, url: string) => {
      const thread =
        supported && threadRef.environmentId === environmentId ? readThreadShell(threadRef) : null;
      return thread === null
        ? null
        : findThreadIssueLink(thread.issues ?? [], url, savedIssueRef(url));
    };
    const changeLink = async (threadRef: ScopedThreadRef, url: string, linked: boolean) => {
      if (!linked) {
        const issue = linkedIssueFor(threadRef, url);
        if (issue === null) throw new Error("This issue is no longer linked.");
        unwrap(
          await updateMetadata({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              issueUnlink: {
                provider: issue.provider,
                repository: issue.repository,
                number: issue.number,
                url: issue.url,
              },
            },
          }),
        );
        return;
      }
      const resolved = resolve(threadRef, url);
      if (resolved === null) throw new Error("The issue is not available in this environment.");
      if ("error" in resolved) throw new Error(resolved.error);
      const detail = unwrap(
        await readDetail({ environmentId: threadRef.environmentId, input: resolved.issue }),
      );
      if (!linkIssuePreviewMatchesReference(url, detail)) {
        throw new Error(
          detail.provider === "linear"
            ? "This project is connected to a different Linear workspace. Check its Linear account."
            : `${detail.repository} #${detail.number} is a pull request, not an issue.`,
        );
      }
      if (linkedIssueFor(threadRef, detail.url) !== null) {
        throw new Error(`${detail.repository} #${detail.number} is already linked to this thread.`);
      }
      unwrap(
        await updateMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            issueLink: {
              projectId: detail.projectId,
              provider: detail.provider,
              repository: detail.repository,
              number: detail.number,
              url: detail.url,
              title: detail.title,
            },
          },
        }),
      );
    };
    return { canLink, linkedIssueFor, changeLink };
  }, [environmentId, linearBindings, projects, readDetail, supported, updateMetadata]);
}
