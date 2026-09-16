import { useCallback, useMemo } from "react";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  matchesLinkedPullRequestUrl,
  parseChangeRequestUrl,
} from "~/lib/openPullRequestLink";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { readProjects, readServerConfigs, useProjects, useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/** The three writes, which depend on nothing a render can change. */
function usePullRequestLinkCommands() {
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  return useMemo(() => ({ link, unlink, updateMetadata }), [link, unlink, updateMetadata]);
}

function buildPullRequestLinking({
  environmentId,
  capabilities,
  projects,
  commands,
}: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly capabilities: Parameters<typeof threadPullRequestLinkMode>[0];
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly commands: ReturnType<typeof usePullRequestLinkCommands>;
}) {
  const { link, unlink, updateMetadata } = commands;
  const mode = threadPullRequestLinkMode(capabilities);
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const canLink = (url: string) => {
    const parsed = parseChangeRequestUrl(url);
    if (parsed === null || mode === "unsupported") return false;
    return (
      (mode === "multiple" ? findProjectOnChangeRequestHost : findProjectForChangeRequest)(
        environmentProjects,
        parsed,
      ) !== undefined
    );
  };
  const isLinked = (
    thread: {
      readonly pullRequests?: readonly ThreadPullRequestLink[];
      readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
    } | null,
    url: string,
  ) => {
    if (thread === null || mode === "unsupported") return false;
    if (mode !== "multiple")
      return (
        thread.linkedPullRequest != null &&
        matchesLinkedPullRequestUrl(thread.linkedPullRequest, url)
      );
    const parsed = parseChangeRequestUrl(url);
    return (
      parsed !== null &&
      visibleThreadPullRequests(thread.pullRequests ?? []).some((entry) =>
        threadPullRequestKeysEqual(entry, parsed),
      )
    );
  };
  const changeLink = async (threadRef: ScopedThreadRef, url: string, linked: boolean) => {
    const parsed = parseChangeRequestUrl(url);
    if (parsed === null || threadRef.environmentId !== environmentId || (linked && !canLink(url)))
      throw new Error("The pull request is not available in this environment.");
    const legacyProject = findProjectForChangeRequest(environmentProjects, parsed);
    const mutation = planThreadPullRequestMutation({
      capabilities,
      threadId: threadRef.threadId,
      reference: { ...parsed, url },
      legacyProjectId: legacyProject?.id ?? null,
      legacyRepository:
        sourceControlRepositorySelector(legacyProject?.repositoryIdentity) ?? undefined,
      linked,
    });
    if (mutation === null)
      throw new Error("This environment does not support linking this pull request.");
    const result = await (mutation.type === "thread.meta.update"
      ? updateMetadata({ environmentId: threadRef.environmentId, input: mutation.input })
      : mutation.type === "thread.pull-request.link"
        ? link({ environmentId: threadRef.environmentId, input: mutation.input })
        : unlink({ environmentId: threadRef.environmentId, input: mutation.input }));
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
      throw squashAtomCommandFailure(result);
    }
  };
  return { mode, canLink, isLinked, changeLink };
}

/** Routes link actions through the command advertised by this environment. */
export function usePullRequestLinking(environmentId: EnvironmentId | null | undefined) {
  const configs = useServerConfigs();
  const projects = useProjects();
  const commands = usePullRequestLinkCommands();
  const capabilities =
    environmentId == null ? undefined : configs.get(environmentId)?.environment.capabilities;
  return useMemo(
    () => buildPullRequestLinking({ environmentId, capabilities, projects, commands }),
    [capabilities, commands, environmentId, projects],
  );
}

/**
 * The same actions, resolved on the click rather than on every render.
 *
 * A caller that only acts once a menu is open has no use for the projects or the server config
 * while it waits. This one is mounted per thread row, so subscribing there would put a project
 * or config change through every row in the list and filter the whole projects array once per row.
 */
export function useLazyPullRequestLinking(environmentId: EnvironmentId | null | undefined) {
  const commands = usePullRequestLinkCommands();
  return useCallback(
    () =>
      buildPullRequestLinking({
        environmentId,
        capabilities:
          environmentId == null
            ? undefined
            : readServerConfigs().get(environmentId)?.environment.capabilities,
        projects: readProjects(),
        commands,
      }),
    [commands, environmentId],
  );
}
