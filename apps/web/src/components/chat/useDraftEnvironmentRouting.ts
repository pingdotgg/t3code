import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTriagePrompt, replaceTriagePlaybookLink } from "@t3tools/shared/triagePrompt";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  type CloudEnvironmentSelection,
  isCloudEnvironmentSelection,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { currentClientMetadata } from "../../connection/platform";
import { useProjects } from "../../state/entities";
import { rememberOpenedBoatCloudThread } from "../../state/boatCloudThreads";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { DraftSessionState } from "../../composerDraftStore";
import { loadBalancingSendWarning } from "./composerSend.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { seedDraftModelSelection } from "../../lib/seedDraftModelSelection";
import { draftFanoutSelectionsAtom } from "./chatViewSend";
import {
  boatCloudReady,
  clearBoatCloudStartProgress,
  prepareBoatCloudProject,
  prewarmBoatCloudProject,
  usePrimaryBoatCloudStatus,
} from "../../boatCloud";
import {
  boxdCloudReady,
  clearBoxdCloudStartProgress,
  prepareBoxdCloudProject,
  prewarmBoxdCloudProject,
  usePrimaryBoxdCloudStatus,
} from "../../boxdCloud";

interface DraftEnvironmentRoutingInput {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

// Multiple-model selections are kept per route, so a draft moving machine takes them along.
function carryFanoutSelections(
  draft: Pick<DraftSessionState, "environmentId" | "threadId">,
  environmentId: EnvironmentId,
) {
  if (draft.environmentId === environmentId) return;
  const selectionsOn = (id: EnvironmentId) =>
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(id, draft.threadId)));
  appAtomRegistry.set(
    selectionsOn(environmentId),
    appAtomRegistry.get(selectionsOn(draft.environmentId)),
  );
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine. A triage draft takes its session along: the
 * target machine prepares one, and the playbook link follows.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const prepareTriage = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = automaticEnvironment
    ? logicalProjectEnvironments
        .filter((candidate) => {
          const environment = environmentById.get(candidate.environmentId);
          return (
            environment?.connection.phase === "connected" &&
            (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
            referencedThreadContexts.every(
              (record) => record.environmentId === candidate.environmentId,
            ) &&
            providersByEnvironment
              .get(candidate.environmentId)
              ?.some(
                (provider) =>
                  (activeProviderInstanceId === null ||
                    provider.instanceId === activeProviderInstanceId) &&
                  provider.driver === selectedProvider &&
                  (environment.serverConfig?.settings
                    ? resolveProjectProviderInstanceEnabled(
                        environment.serverConfig.settings,
                        candidate.projectId,
                        provider.instanceId,
                      )
                    : provider.enabled) &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.availability !== "unavailable",
              )
          );
        })
        .map((candidate) => candidate.environmentId)
    : [];
  const loadBalancing = useLoadBalancedEnvironment(
    needsLoadBalancing ? loadBalancingCandidates : [],
    loadBalancingSettings.loadBalancingWeights,
  );
  const readRouting = useStableCallback(() => ({ input, loadBalancingCandidates }));
  const boatCloud = usePrimaryBoatCloudStatus();
  const boxdCloud = usePrimaryBoxdCloudStatus();
  const clouds = {
    cloud: {
      name: "Boat cloud",
      holderEnvironmentId: boatCloud.holderEnvironmentId,
      ready: boatCloudReady(boatCloud.status),
      prepare: prepareBoatCloudProject,
      prewarm: prewarmBoatCloudProject,
      clear: clearBoatCloudStartProgress,
    },
    boxd: {
      name: "boxd cloud",
      holderEnvironmentId: boxdCloud.holderEnvironmentId,
      ready: boxdCloudReady(boxdCloud.status),
      prepare: prepareBoxdCloudProject,
      prewarm: prewarmBoxdCloudProject,
      clear: clearBoxdCloudStartProgress,
    },
  } satisfies Record<CloudEnvironmentSelection, unknown>;
  /**
   * Moves the draft onto a Boat cloud VM's checkout of the same repository,
   * keeping its model, base branch, attachments and access settings. Cloud
   * threads always start in a new worktree.
   */
  /** What starting this draft on a cloud needs, or why it cannot start. */
  const boatCloudStart = (
    draft: NonNullable<ReturnType<typeof getDraftSession>>,
    selection: CloudEnvironmentSelection,
  ) => {
    const cloud = clouds[selection];
    if (cloud.holderEnvironmentId === null || !cloud.ready) {
      return {
        title: `${cloud.name} is not set up`,
        description: "Finish setup in Settings, Cloud.",
      };
    }
    const project = allProjects.find(
      (candidate) =>
        candidate.environmentId === draft.environmentId && candidate.id === draft.projectId,
    );
    // A fork's own remote, where the agent can push, rather than the upstream it groups under.
    const identity = project?.repositoryIdentity;
    const repositoryUrl = identity?.origin?.remoteUrl ?? identity?.locator.remoteUrl;
    if (!repositoryUrl) {
      return {
        title: `${cloud.name} needs a git remote`,
        description: "Push this project to a remote the VM can clone.",
      };
    }
    if (!draft.branch) {
      return {
        title: "Choose a base branch",
        description: `${cloud.name} starts a new worktree from it.`,
      };
    }
    return {
      holderEnvironmentId: cloud.holderEnvironmentId,
      repositoryUrl,
      baseBranch: draft.branch,
    };
  };
  const moveToBoatCloud = async (selection: CloudEnvironmentSelection) => {
    if (!draftId) return false;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft) return false;
    const start = boatCloudStart(originalDraft, selection);
    if ("title" in start) {
      toastManager.add({ type: "warning", id: "boat-cloud-send", ...start });
      return false;
    }
    const target = await clouds[selection].prepare({ draftId, ...start });
    if (!target) return false;
    const currentDraft = getDraftSession(draftId);
    if (
      !currentDraft ||
      currentDraft.promotedTo ||
      currentDraft.environmentSelection !== selection ||
      currentDraft.environmentId !== originalDraft.environmentId ||
      currentDraft.projectId !== originalDraft.projectId
    ) {
      // The draft moved on while the VM started; the VM stays ready for the next send.
      clouds[selection].clear(draftId);
      return false;
    }
    const { project, worktree } = target;
    const baseBranch = currentDraft.branch ?? originalDraft.branch;
    // The VM cut the worktree from the base the start asked for; a base picked since needs a new one.
    const readyWorktree = worktree?.baseBranch === baseBranch ? worktree : null;
    carryFanoutSelections(originalDraft, project.environmentId);
    // The send must read the VM project's composer and provider context after retargeting.
    // Attachments stay on the draft; the send uploads them to the VM it now targets.
    flushSync(() =>
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(project.environmentId, project.id),
        environmentSelection: selection,
        loadBalancedEnvironmentId: null,
        envMode: "worktree",
        // The thread takes the VM's worktree, or the VM cuts one from the remote base, since its
        // clone has none of this machine's local branches. A path on this machine means nothing there.
        ...(readyWorktree === null
          ? { branch: baseBranch, startFromOrigin: true, worktreePath: null }
          : { branch: readyWorktree.branch, worktreePath: readyWorktree.path }),
      }),
    );
    // The thread is listed from its first event, before the route moves to it.
    rememberOpenedBoatCloudThread({
      environmentId: project.environmentId,
      threadId: currentDraft.threadId,
    });
    return true;
  };
  /** The send that followed a move to a cloud went out, so its start is over. */
  const onRoutedSendDispatched = () => {
    if (!draftId) return;
    clearBoatCloudStartProgress(draftId);
    clearBoxdCloudStartProgress(draftId);
  };
  const refreshBeforeSend = () => {
    const selection = draftThread?.environmentSelection;
    if (draftId && isCloudEnvironmentSelection(selection) && !draftThread?.promotedTo) {
      return moveToBoatCloud(selection);
    }
    if (
      !automaticEnvironment ||
      !draftId ||
      !draftThread?.loadBalancedEnvironmentId ||
      draftThread.promotedTo ||
      composerHasAttachments
    )
      return null;
    const originalDraft = getDraftSession(draftId);
    const composerDraft = useComposerDraftStore.getState().getComposerDraft(draftId);
    return loadBalancing.refreshSelection(loadBalancingCandidates).then((environmentId) => {
      const current = readRouting();
      if (
        current.input.draftId !== draftId ||
        !current.input.automaticEnvironment ||
        current.input.composerHasAttachments ||
        current.input.activeProjectKey !== activeProjectKey ||
        current.input.selectedProvider !== selectedProvider ||
        current.input.activeProviderInstanceId !== activeProviderInstanceId ||
        current.input.loadBalancingSettings.loadBalancingWeights !==
          loadBalancingSettings.loadBalancingWeights ||
        current.loadBalancingCandidates.join("\n") !== loadBalancingCandidates.join("\n") ||
        getDraftSession(draftId) !== originalDraft ||
        useComposerDraftStore.getState().getComposerDraft(draftId) !== composerDraft
      )
        return false;
      const target = current.input.logicalProjectEnvironments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!target?.projectId) {
        toastManager.add({
          type: "warning",
          ...loadBalancingSendWarning({
            pending: false,
            threadContexts: referencedThreadContexts,
            candidateEnvironmentIds: loadBalancingCandidates,
          }),
        });
        return false;
      }
      const projectRef = scopeProjectRef(target.environmentId, target.projectId);
      if (originalDraft) carryFanoutSelections(originalDraft, target.environmentId);
      // The send must read the target project's composer and provider context after retargeting.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "auto",
          loadBalancedEnvironmentId: target.environmentId,
          branch: originalDraft?.branch ?? null,
        }),
      );
      return true;
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    const draft = getDraftSession(draftId);
    if (draft) carryFanoutSelections(draft, target.environmentId);
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const onCloudEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    setDraftThreadContext(draftId, {
      environmentSelection: "cloud",
      loadBalancedEnvironmentId: null,
      envMode: "worktree",
      worktreePath: null,
    });
    // The VM starts while the message is written; the send reuses this start.
    const draft = getDraftSession(draftId);
    const start = draft ? boatCloudStart(draft, "cloud") : null;
    if (start && !("title" in start)) prewarmBoatCloudProject({ draftId, ...start });
  };
  const onCloudEnvironmentStable = useStableCallback(onCloudEnvironment);
  const onBoxdEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    setDraftThreadContext(draftId, {
      environmentSelection: "boxd",
      loadBalancedEnvironmentId: null,
      envMode: "worktree",
      worktreePath: null,
    });
    const draft = getDraftSession(draftId);
    const start = draft ? boatCloudStart(draft, "boxd") : null;
    if (start && !("title" in start)) prewarmBoxdCloudProject({ draftId, ...start });
  };
  const onBoxdEnvironmentStable = useStableCallback(onBoxdEnvironment);
  const onLeaveBoxdEnvironment = () => {
    if (!draftId || sendInFlightRef.current) return;
    clearBoxdCloudStartProgress(draftId);
    setDraftThreadContext(draftId, { environmentSelection: "manual" });
  };
  const onLeaveBoxdEnvironmentStable = useStableCallback(onLeaveBoxdEnvironment);
  const onLeaveCloudEnvironment = () => {
    if (!draftId || sendInFlightRef.current) return;
    clearBoatCloudStartProgress(draftId);
    setDraftThreadContext(draftId, { environmentSelection: "manual" });
  };
  const onLeaveCloudEnvironmentStable = useStableCallback(onLeaveCloudEnvironment);
  const cloudSelected = draftThread?.environmentSelection === "cloud";
  // Offered on a new draft once this machine has Boat cloud ready; kept visible while chosen.
  const cloudEnvironment =
    draftId &&
    !envLocked &&
    !draftThread?.promotedTo &&
    (cloudSelected || boatCloudReady(boatCloud.status))
      ? {
          selected: cloudSelected,
          onSelect: onCloudEnvironmentStable,
          onLeave: onLeaveCloudEnvironmentStable,
        }
      : undefined;
  const boxdSelected = draftThread?.environmentSelection === "boxd";
  const boxdEnvironment =
    draftId && !envLocked && !draftThread?.promotedTo && (boxdSelected || clouds.boxd.ready)
      ? {
          selected: boxdSelected,
          onSelect: onBoxdEnvironmentStable,
          onLeave: onLeaveBoxdEnvironmentStable,
        }
      : undefined;
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the current change scope into a ref that async environment switches compare against
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons an in-flight environment change when the draft or project scope changes or unmounts
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target) return;
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    // `triagePrompt` is the prompt the target machine prepared for a triage draft.
    const retarget = (project: (typeof allProjects)[number], triagePrompt?: string) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      if (triagePrompt !== undefined) {
        // Read now, so text typed while the machine prepared the session is kept.
        const prompt = getComposerDraft(draftId)?.prompt ?? "";
        const nextPrompt = replaceTriagePlaybookLink(prompt, triagePrompt);
        if (nextPrompt !== prompt) setPrompt(draftId, nextPrompt);
      }
      carryFanoutSelections(currentDraft, target.environmentId);
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      }
      seedDraftModelSelection(draftId, projectRef);
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    const knownProject = allProjects.find(
      (project) =>
        project.environmentId === target.environmentId && project.id === target.projectId,
    );
    // The playbook and context files exist only on the machine that prepared them.
    const followsTriage = isTriagePrompt(getComposerDraft(draftId)?.prompt ?? "");
    if (target.projectId !== null && !(knownProject && followsTriage)) {
      if (knownProject) retarget(knownProject);
      finish();
      return;
    }
    const prepareTriagePrompt = async () => {
      const prepared = await prepareTriage({
        environmentId: target.environmentId,
        input: { client: currentClientMetadata() },
      });
      if (prepared._tag === "Success") return prepared.value.prompt;
      if (!isAtomCommandInterrupted(prepared)) {
        const error = squashAtomCommandFailure(prepared);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not switch machine",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return null;
    };
    const switchMachine = async () => {
      const triagePrompt = followsTriage ? await prepareTriagePrompt() : undefined;
      if (triagePrompt === null) return;
      const project =
        knownProject ??
        (await openScratchProject(target.environmentId, "Could not switch machine"));
      if (project) retarget(project, triagePrompt);
    };
    setBusyEnvironmentChange(request);
    void switchMachine().finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    refreshBeforeSend,
    onRoutedSendDispatched,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    cloudEnvironment,
    boxdEnvironment,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
