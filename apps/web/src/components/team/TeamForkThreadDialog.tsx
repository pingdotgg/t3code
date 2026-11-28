import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  extractProjectRepoIdentityKey,
  isTeamHubOnlyServerConfig,
  listAccessibleTeamEnvironments,
  resolveTeamForkModelSelection,
} from "@t3tools/client-runtime/team";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { msg, T, useGT } from "gt-react";
import { GitForkIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { m } from "~/i18n/messages";
import { newMessageId, newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, waitForThreadShell } from "~/state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { environmentThreadStateAtom, threadEnvironment } from "~/state/threads";
import {
  closeTeamForkDialog,
  prepareTeamThreadAccess,
  setTeamDraftViewId,
  useTeamEnvironmentState,
  useTeamForkDialogRequest,
} from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DEFAULT_INTERACTION_MODE } from "~/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

interface ForkTargetOption {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly isDefaultTeam: boolean;
}

function buildPortableHandoffSummary(input: {
  readonly sourceThreadTitle: string;
  readonly sourceThreadId: ThreadId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): string {
  const header = `[Forked from "${input.sourceThreadTitle}" (thread: ${input.sourceThreadId})]`;
  if (input.messages.length === 0) {
    return `${header}\n\n${m(msg("Continue work from the forked thread above."))}`;
  }
  const transcript = input.messages
    .slice(-12)
    .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.text.trim()}`)
    .filter((line) => line.length > 0)
    .join("\n\n");
  return `${header}\n\n${m(msg("Previous conversation context:"))}\n${transcript}\n\n${m(msg("Continue from here."))}`;
}

export function TeamForkThreadDialogHost() {
  const request = useTeamForkDialogRequest();
  const gt = useGT();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const teamState = useTeamEnvironmentState(request?.teamEnvironmentId ?? null);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const [forkingEnvId, setForkingEnvId] = useState<EnvironmentId | null>(null);

  if (request === null) return null;

  const repoKey = extractProjectRepoIdentityKey(request.repositoryIdentity);
  const accessibleTeamEnvs = listAccessibleTeamEnvironments(teamState);
  const envById = new Map(environments.map((env) => [env.environmentId, env] as const));
  const sourceAttribution = teamState.attributionByThreadId.get(request.sourceThreadId) ?? null;
  const inheritedTeamViewId = sourceAttribution?.viewId ?? null;

  const findProjectForEnv = (envId: EnvironmentId): ProjectId | null => {
    if (envId === request.teamEnvironmentId) return request.projectId;
    if (repoKey !== null) {
      const matched = projects.find(
        (p) =>
          p.environmentId === envId &&
          extractProjectRepoIdentityKey(p.repositoryIdentity) === repoKey,
      );
      return matched?.id ?? null;
    }
    const exactIdMatch = projects.find(
      (p) => p.environmentId === envId && p.id === request.projectId,
    );
    return exactIdMatch?.id ?? null;
  };

  const options: ForkTargetOption[] = [];
  const seenEnvIds = new Set<EnvironmentId>();

  if (primaryEnvironmentId && primaryEnvironmentId !== request.teamEnvironmentId) {
    const localEnv = envById.get(primaryEnvironmentId);
    const localProjectId = isTeamHubOnlyServerConfig(localEnv?.serverConfig)
      ? null
      : findProjectForEnv(primaryEnvironmentId);
    if (localProjectId) {
      seenEnvIds.add(primaryEnvironmentId);
      options.push({
        environmentId: primaryEnvironmentId,
        projectId: localProjectId,
        label: localEnv?.label ?? gt("My local environment"),
        isLocal: true,
        isDefaultTeam: false,
      });
    }
  }

  for (const teamEnv of accessibleTeamEnvs) {
    if (seenEnvIds.has(teamEnv.environmentId)) continue;
    const connectedEnv = envById.get(teamEnv.environmentId);
    if (isTeamHubOnlyServerConfig(connectedEnv?.serverConfig)) continue;
    const targetProjectId = findProjectForEnv(teamEnv.environmentId);
    if (!targetProjectId) continue;
    seenEnvIds.add(teamEnv.environmentId);
    options.push({
      environmentId: teamEnv.environmentId,
      projectId: targetProjectId,
      label: teamEnv.name,
      isLocal: false,
      isDefaultTeam: teamEnv.isDefault,
    });
  }

  const runForkTarget = async (option: ForkTargetOption) => {
    const sourceThreadResult = appAtomRegistry.get(
      environmentThreadStateAtom(request.sourceEnvironmentId, request.sourceThreadId),
    );
    const sourceThreadState = AsyncResult.value(sourceThreadResult);
    const sourceProjection =
      Option.isSome(sourceThreadState) && Option.isSome(sourceThreadState.value.data)
        ? sourceThreadState.value.data.value
        : null;
    const sourceMessages = (sourceProjection?.messages ?? []).map((message) => ({
      role: message.role,
      text: message.text,
    }));
    const handoffPrompt = buildPortableHandoffSummary({
      sourceThreadTitle: request.sourceThreadTitle,
      sourceThreadId: request.sourceThreadId,
      sourceEnvironmentId: request.sourceEnvironmentId,
      messages: sourceMessages,
    });

    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(option.environmentId, targetThreadId);
    const targetProviders = providersByEnvironment.get(option.environmentId) ?? [];
    const resolvedModelSelection = resolveTeamForkModelSelection({
      sourceModelSelection: sourceProjection?.thread.modelSelection ?? null,
      targetProviders,
      teamState,
      isLocalTarget: option.isLocal,
    });
    if (resolvedModelSelection === null) {
      toastManager.add({
        type: "error",
        title: gt("No compatible team provider available on {environment}", {
          environment: option.label,
        }),
        description: option.isLocal
          ? gt(
              "Remote-only team providers cannot run locally. Choose a remote team environment or ask an admin to enable a local-compatible team provider.",
            )
          : gt("No enabled team provider is available on this target environment."),
      });
      return;
    }
    const forkTitle = gt("{title} (fork)", { title: request.sourceThreadTitle });
    const teamAccess =
      option.isLocal || option.environmentId === request.teamEnvironmentId
        ? prepareTeamThreadAccess(option.environmentId, targetThreadId, {
            teamEnvironmentId: request.teamEnvironmentId,
            viewId: inheritedTeamViewId,
            locked: false,
          })
        : {};
    const result = await startThreadTurn({
      environmentId: option.environmentId,
      input: {
        threadId: targetThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: handoffPrompt,
          attachments: [],
        },
        modelSelection: resolvedModelSelection,
        titleSeed: forkTitle,
        runtimeMode: sourceProjection?.thread.runtimeMode ?? "auto",
        interactionMode: DEFAULT_INTERACTION_MODE,
        bootstrap: {
          createThread: {
            projectId: option.projectId,
            title: forkTitle,
            modelSelection: resolvedModelSelection,
            runtimeMode: sourceProjection?.thread.runtimeMode ?? "auto",
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: sourceProjection?.thread.branch ?? null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
            ...teamAccess,
          },
        },
        createdAt: new Date().toISOString(),
      },
    });

    if (result._tag === "Success") {
      closeTeamForkDialog();
      await waitForThreadShell(targetThreadRef).catch(() => undefined);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetThreadRef),
      });
      toastManager.add({
        type: "success",
        title: gt("Thread forked"),
        description: gt("Created on {environment}.", { environment: option.label }),
      });
      return;
    }

    if (!isAtomCommandInterrupted(result)) {
      // Fallback: open a draft on the target environment pre-populated with portable handoff text.
      const draftResult = await handleNewThread(
        scopeProjectRef(option.environmentId, option.projectId),
      );
      if (draftResult) {
        useComposerDraftStore.getState().setPrompt(draftResult.draftId, handoffPrompt);
        if (inheritedTeamViewId !== null) {
          // Index by routeThreadKey (matching ChatView & useComposerSend), not draftId.
          const draftRouteThreadKey = scopedThreadKey(
            scopeThreadRef(option.environmentId, draftResult.threadId),
          );
          setTeamDraftViewId(draftRouteThreadKey, inheritedTeamViewId, request.teamEnvironmentId);
        }
        closeTeamForkDialog();
        toastManager.add({
          type: "info",
          title: gt("Fork draft prepared"),
          description:
            thrownErrorMessage(squashAtomCommandFailure(result), m) ??
            gt("Review the handoff prompt and send to start."),
        });
        return;
      }
      toastManager.add({
        type: "error",
        title: gt("Could not fork thread"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    }
  };

  const handleSelectTarget = async (option: ForkTargetOption) => {
    setForkingEnvId(option.environmentId);
    await runForkTarget(option).finally(() => {
      setForkingEnvId(null);
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && forkingEnvId === null) closeTeamForkDialog();
      }}
    >
      <DialogPopup className="max-w-md" data-testid="team-fork-thread-dialog">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <GitForkIcon className="size-4" aria-hidden />
              <T>Fork this thread</T>
            </span>
          </DialogTitle>
          <DialogDescription>
            <T>
              Choose an environment you have access to. A new thread owned by you will start with
              portable context from this conversation.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {options.length === 0 ? (
            <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-sm">
              <p className="font-medium text-foreground">
                <T>No accessible environments with this project are available.</T>
              </p>
              <p className="text-xs text-muted-foreground">
                <T>
                  To fork this thread, add or clone this repository on your local machine or ask a
                  team admin to grant you access to a remote environment that has the project. You
                  can also leave a thread note instead.
                </T>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    closeTeamForkDialog();
                    void navigate({ to: "/settings/teams", hash: "teams-environments" });
                  }}
                >
                  <T>View team environments</T>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2" data-testid="team-fork-env-options">
              {options.map((option) => (
                <button
                  key={option.environmentId}
                  type="button"
                  disabled={forkingEnvId !== null}
                  data-testid={`team-fork-env-${option.environmentId}`}
                  onClick={() => void handleSelectTarget(option)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50 disabled:opacity-60"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {option.isLocal ? (
                      <LaptopIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <ServerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate font-medium text-foreground">{option.label}</span>
                    {option.isLocal ? (
                      <Badge variant="outline" size="sm">
                        <T>Local</T>
                      </Badge>
                    ) : option.isDefaultTeam ? (
                      <Badge variant="secondary" size="sm">
                        <T>Default team</T>
                      </Badge>
                    ) : null}
                  </div>
                  {forkingEnvId === option.environmentId ? <Spinner size="xs" /> : null}
                </button>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={forkingEnvId !== null}
            onClick={closeTeamForkDialog}
          >
            <T>Cancel</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
