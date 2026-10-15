import * as Dialog from "../../components/Dialog";
import { StackActions, useNavigation } from "@react-navigation/native";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  findPromptLinkProject,
  findPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "@t3tools/client-runtime/prompt-links";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
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

/** What a `new` link asks for, in one shape for every destination. */
type LinkedDraftRequest = {
  readonly prompt: LinkedPrompt | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly pullRequest: PromptLinkPullRequest | null;
};

/**
 * Opens a `t3code://new?…` link. The link lands on the New Task picker with its query as route
 * params; this resolves it to a project, a thread, or a choice, then fills a draft. Nothing is
 * ever sent: the user reads the prompt and presses Send. Used by `NewTaskRouteScreen`.
 */
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
  const search = promptLinkSearchFromParams(params);
  // A cold launch from a link has no projects or threads yet. Matching then would offer to
  // clone a repository the user already has.
  const waitingForShells =
    catalogState.isLoadingConnections ||
    catalogState.hasPendingShellSnapshot ||
    // A machine still connecting may hold the repository or thread. One that keeps failing to
    // reconnect has settled offline, and must not hold every link.
    catalogState.connectingEnvironments.some(
      (environment) =>
        environment.connectionState === "connecting" || environment.connectionError === null,
    );

  // Writes the prompt and the requested model into a draft. Returns true when the link named a
  // model the user cannot use, so their default stands in.
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
      // The same draft the PR screen's Ask makes: Send checks out the PR head in a worktree.
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
      StackActions.push("NewTaskDraft", {
        draftId: draftKey,
        title: request.pullRequest ? `PR #${request.pullRequest.number}` : project.title,
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
      // Machines by their latest thread, scratch threads included.
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

  // Clone needs a tap on the destination screen, which then opens a draft in the cloned project
  // holding the prompt. A pull request's prompt belongs on its branch, which only exists once the
  // clone is done, so that link, like any on an older server, has to be opened again.
  const cloneRepository = (repository: PromptLinkRepository, request: LinkedDraftRequest) => {
    const environmentId =
      flow.selectedEnvironmentId ?? connectedEnvironments[0]?.environmentId ?? null;
    if (environmentId === null) {
      Dialog.alert("Could not clone", "Connect an environment first.");
      return;
    }
    // Only a tracked clone opens a draft the prompt can ride into; older servers do not.
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
        (navigation.getParent() ?? navigation).dispatch(
          StackActions.replace("Thread", {
            environmentId: String(thread.environmentId),
            threadId: String(thread.id),
          }),
        );
        if (link.prompt) {
          void applyLinkedPromptToThreadDraft(
            scopedThreadKey(thread.environmentId, thread.id),
            link.prompt,
            promptLinkNotice({ hiddenCharacters: link.prompt.hiddenCharacters }),
          );
        }
        return;
      }
    }

    const repository = link.kind === "new" ? link.repository : link.pullRequest;
    if (repository === null) {
      void openScratchDraft(request);
      return;
    }
    // Most recently active first, so the user lands where they last worked. Scopes are ordered
    // that way, but the checkouts inside one are not.
    const lastActivity = new Map<string, string>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      if (thread.updatedAt > (lastActivity.get(key) ?? "")) lastActivity.set(key, thread.updatedAt);
    }
    const activityOf = (project: EnvironmentProject) =>
      lastActivity.get(`${project.environmentId}:${project.id}`) ?? "";
    const project = findPromptLinkProject(
      flow.projectScopes
        .flatMap((scope) => scope.projects)
        .sort((left, right) => activityOf(right).localeCompare(activityOf(left))),
      repository,
    );
    if (project) {
      void openProjectDraft(project, request);
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

  // Handle each link once. Clearing the params lets the same link open again later.
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
