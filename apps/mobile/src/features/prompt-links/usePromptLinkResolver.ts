import * as Dialog from "../../components/ui/Dialog";
import { StackActions, useNavigation } from "@react-navigation/native";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  findPromptLinkProjects,
  findPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "@t3tools/client-runtime/prompt-links";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  parseNewThreadLink,
  type LinkedPrompt,
  type PromptLinkPullRequest,
  type PromptLinkRepository,
} from "@t3tools/shared/promptLinks";
import { useEffect, useEffectEvent, useRef } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import { useNewTaskFlow } from "../threads/new-task-flow-provider";
import { applyLinkedPromptToThreadDraft, showPromptLinkNotice } from "./prompt-link-actions";
import {
  clearedPromptLinkParams,
  promptLinkNotice,
  promptLinkRepositoryName,
  latestThreadEnvironmentIds,
  promptLinkScratchEnvironmentId,
  promptLinkSearchFromParams,
} from "./prompt-link-model";

type LinkedDraftRequest = {
  readonly prompt: LinkedPrompt | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly pullRequest: PromptLinkPullRequest | null;
};

export function usePromptLinkResolver(params: Readonly<Record<string, unknown>> | undefined) {
  const navigation = useNavigation();
  const flow = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const loadPullRequest = useAtomQueryRunner(composerPullRequests.detail, {
    reportFailure: false,
  });
  const loadLinkedThreads = useAtomQueryRunner(composerPullRequests.linkedThreadsUncached, {
    reportFailure: false,
  });
  const search = promptLinkSearchFromParams(params);
  // Wait for cold-launch shells or existing repositories may be offered for cloning.
  const waitingForShells =
    catalogState.isLoadingConnections ||
    catalogState.hasPendingShellSnapshot ||
    // Connecting machines may hold the target; persistently offline ones must not block every link.
    catalogState.connectingEnvironments.some(
      (environment) =>
        environment.connectionState === "connecting" || environment.connectionError === null,
    );

  const writeDraft = (
    draftKey: string,
    environmentId: EnvironmentId,
    request: LinkedDraftRequest,
  ): boolean => {
    if (request.prompt) setComposerDraftText(draftKey, request.prompt.text);
    if (request.provider === null) return false;
    const resolved = resolvePromptLinkModelSelection(
      serverConfigs.get(environmentId)?.providers ?? [],
      { provider: request.provider, model: request.model },
    );
    if (resolved) updateComposerDraftSettings(draftKey, { modelSelection: resolved.selection });
    return resolved?.exact !== true;
  };

  const openThread = (
    thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
    prompt: LinkedDraftRequest["prompt"],
  ) => {
    (navigation.getParent() ?? navigation).dispatch(
      StackActions.replace("Thread", {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      }),
    );
    if (prompt) {
      void applyLinkedPromptToThreadDraft(
        scopedThreadKey(thread.environmentId, thread.id),
        prompt,
        promptLinkNotice({ hiddenCharacters: prompt.hiddenCharacters }),
      );
    }
  };

  // A pull request's thread can be an older settled thread no shell holds, so ask every
  // connected environment with the repository. A lookup on another one would wait forever.
  const findServerPullRequestThread = async (
    projects: ReadonlyArray<EnvironmentProject>,
    pullRequest: PromptLinkPullRequest,
  ) => {
    const connected = new Set(
      connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    );
    const lookups = projects
      .filter((project) => connected.has(project.environmentId))
      .map(async (project) => {
        const linked = await loadLinkedThreads({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            repository: promptLinkRepositoryName(pullRequest),
            number: pullRequest.number,
          },
        });
        const thread =
          linked._tag === "Success"
            ? linked.value.threads.find((candidate) => candidate.archivedAt === null)
            : undefined;
        return thread && { environmentId: project.environmentId, id: thread.id };
      });
    // The most recent project wins without waiting for the lookups after it.
    for (const lookup of lookups) {
      const thread = await lookup;
      if (thread) return thread;
    }
    return undefined;
  };

  const openProjectDraft = async (project: EnvironmentProject, request: LinkedDraftRequest) => {
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      Dialog.alert(
        "Could not open link",
        "Drafts could not be loaded, so the prompt was not added.",
      );
      return;
    }
    const draftKey = createNewTaskDraft({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    let pullRequestUnavailable: number | null = null;
    if (request.pullRequest) {
      const detail = await loadPullRequest({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          repository: promptLinkRepositoryName(request.pullRequest),
          number: request.pullRequest.number,
        },
      });
      if (detail._tag === "Success") {
        updateComposerDraftSettings(draftKey, {
          workspaceSelection: {
            mode: "worktree",
            branch: detail.value.headBranch,
            worktreePath: null,
            startFromOrigin: false,
            pullRequestReference: detail.value.url,
          },
        });
      } else {
        pullRequestUnavailable = request.pullRequest.number;
      }
    }
    const modelUnavailable = writeDraft(draftKey, project.environmentId, request);
    navigation.dispatch(
      StackActions.push("Thread", {
        draft: {
          draftId: draftKey,
          title: request.pullRequest ? `PR #${request.pullRequest.number}` : project.title,
        },
      }),
    );
    if (request.prompt || pullRequestUnavailable !== null || modelUnavailable) {
      showPromptLinkNotice(
        promptLinkNotice({
          hiddenCharacters: request.prompt?.hiddenCharacters ?? 0,
          modelUnavailable,
          pullRequestUnavailable,
        }),
      );
    }
  };

  const openScratchDraft = async (request: LinkedDraftRequest) => {
    const environmentId = promptLinkScratchEnvironmentId(
      latestThreadEnvironmentIds(threads),
      connectedEnvironments
        .filter(
          (environment) =>
            availableScratchWorkspaceRoot(
              environment.connectionState,
              serverConfigs.get(environment.environmentId),
            ) !== null,
        )
        .map((environment) => environment.environmentId),
    );
    if (environmentId === null) {
      Dialog.alert(
        "Could not start without a project",
        "No connected environment offers threads without a project.",
      );
      return;
    }
    const result = await openScratch({ environmentId, input: {} });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Could not start without a project",
          error instanceof Error
            ? error.message
            : "The folder for threads without a project could not be created.",
        );
      }
      return;
    }
    await openProjectDraft(result.value, { ...request, pullRequest: null });
  };

  const cloneRepository = (repository: PromptLinkRepository, request: LinkedDraftRequest) => {
    const environmentId =
      flow.selectedEnvironmentId ?? connectedEnvironments[0]?.environmentId ?? null;
    if (environmentId === null) {
      Dialog.alert("Could not clone", "Connect an environment first.");
      return;
    }
    const prompt =
      request.pullRequest === null &&
      serverConfigs.get(environmentId)?.environment.capabilities.projectCloneTracking === true
        ? request.prompt
        : null;
    const name = promptLinkRepositoryName(repository);
    navigation.dispatch(
      StackActions.push("AddProjectDestination", {
        environmentId,
        remoteUrl: `https://github.com/${name}.git`,
        repositoryTitle: name,
        repositoryName: repository.name,
        ...(prompt ? { prompt: prompt.text } : {}),
      }),
    );
    if (!request.prompt) return;
    showPromptLinkNotice(
      [
        promptLinkNotice({
          hiddenCharacters: request.prompt.hiddenCharacters,
          modelUnavailable: prompt !== null && request.provider !== null,
        }),
        prompt
          ? "The prompt opens in a new task once the clone starts."
          : "Open the link again after the clone to get the prompt.",
      ].join("\n\n"),
    );
  };

  const resolveLink = useEffectEvent((linkSearch: string) => {
    const parsed = parseNewThreadLink(linkSearch);
    if (!parsed.ok) {
      Dialog.alert("Could not open link", parsed.error);
      return;
    }
    const link = parsed.value;
    const request: LinkedDraftRequest =
      link.kind === "new"
        ? { prompt: link.prompt, provider: link.provider, model: link.model, pullRequest: null }
        : { prompt: link.prompt, provider: null, model: null, pullRequest: link.pullRequest };

    if (link.kind === "pull-request") {
      const thread = findPromptLinkPullRequestThread(threads, link.pullRequest);
      if (thread) {
        openThread(thread, link.prompt);
        return;
      }
    }

    const repository = link.kind === "new" ? link.repository : link.pullRequest;
    if (repository === null) {
      void openScratchDraft(request);
      return;
    }
    const lastActivity = new Map<string, string>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      if (thread.updatedAt > (lastActivity.get(key) ?? "")) lastActivity.set(key, thread.updatedAt);
    }
    const activityOf = (project: EnvironmentProject) =>
      lastActivity.get(`${project.environmentId}:${project.id}`) ?? "";
    const projects = findPromptLinkProjects(
      flow.projectScopes
        .flatMap((scope) => scope.projects)
        .sort((left, right) => activityOf(right).localeCompare(activityOf(left))),
      repository,
    );
    const project = projects[0];
    if (project) {
      const { pullRequest } = request;
      void (async () => {
        const thread = pullRequest && (await findServerPullRequestThread(projects, pullRequest));
        if (thread) openThread(thread, request.prompt);
        else await openProjectDraft(project, request);
      })();
      return;
    }
    Dialog.alert(`You don't have ${promptLinkRepositoryName(repository)}`, undefined, [
      { text: "Cancel", style: "cancel" },
      ...(request.prompt
        ? [{ text: "Use without project", onPress: () => void openScratchDraft(request) }]
        : []),
      { text: "Clone", onPress: () => cloneRepository(repository, request) },
    ]);
  });

  const handledSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (search === null) {
      handledSearchRef.current = null;
      return;
    }
    if (waitingForShells || handledSearchRef.current === search) return;
    handledSearchRef.current = search;
    navigation.setParams(clearedPromptLinkParams());
    resolveLink(search);
  }, [navigation, search, waitingForShells]);
}
