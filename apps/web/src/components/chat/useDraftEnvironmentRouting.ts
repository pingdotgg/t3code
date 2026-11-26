import { msg, useGT } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ScopedProjectRef,
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
import { shallow } from "zustand/shallow";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { currentClientMetadata } from "../../connection/platform";
import { readProject, readProjects, subscribeProjects, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { DraftSessionState } from "../../composerDraftStore";
import { loadBalancingSendWarning } from "./composerSend.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { retargetDraftWorkspace } from "../../lib/retargetDraftWorkspace";
import { trackPendingWorkspaceDefault } from "../../lib/draftWorkspaceDefaults";
import { vcsEnvironment } from "../../state/vcs";
import { resolveDefaultWorktreeBaseBranch } from "../BranchToolbar.logic";
import { seedDraftModelSelection } from "../../lib/seedDraftModelSelection";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

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

// A send waits on this; a read stuck on a reconnecting machine falls back to no project file.
function readDestinationWorkspace(draft: DraftSessionState, projectRef: ScopedProjectRef) {
  return retargetDraftWorkspace(draft, projectRef, AbortSignal.timeout(5_000));
}

function changesProject(draft: DraftSessionState, projectRef: ScopedProjectRef) {
  return (
    draft.environmentId !== projectRef.environmentId || draft.projectId !== projectRef.projectId
  );
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine. A triage draft takes its session along: the
 * target machine prepares one, and the playbook link follows.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const gt = useGT();
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
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
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
  const mountedRoutingScope = useRef<object | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates send preparation when the draft or project scope closes
  useLayoutEffect(() => {
    mountedRoutingScope.current = { draftId, activeProjectKey };
    return () => {
      mountedRoutingScope.current = null;
    };
  }, [draftId, activeProjectKey]);
  const readRouting = useStableCallback(() => ({ input, loadBalancingCandidates }));
  const readWorktreeBase = async (projectRef: ScopedProjectRef, branch: string | null) => {
    const cwd = readProject(projectRef)?.workspaceRoot;
    if (!cwd) return null;
    const { environmentId } = projectRef;
    const call = { signal: AbortSignal.timeout(5_000) };
    if (branch) {
      let cursor: number | undefined;
      do {
        const matching = await readRefs(
          {
            environmentId,
            input: { cwd, query: branch.slice(0, 256), cursor, includeMatchingRemoteRefs: true },
          },
          call,
        );
        if (matching._tag !== "Success") break;
        if (matching.value.refs.some((ref) => ref.name === branch)) return branch;
        cursor = matching.value.nextCursor ?? undefined;
      } while (cursor !== undefined && !call.signal.aborted);
    }
    const result = await readRefs({ environmentId, input: { cwd, limit: 2 } }, call);
    return result._tag === "Success" ? resolveDefaultWorktreeBaseBranch(result.value.refs) : null;
  };
  const refreshBeforeSend = () => {
    if (
      !automaticEnvironment ||
      !draftId ||
      !draftThread?.loadBalancedEnvironmentId ||
      draftThread.promotedTo ||
      composerHasAttachments
    )
      return null;
    const originalDraft = getDraftSession(draftId);
    const scope = mountedRoutingScope.current;
    if (!originalDraft || !scope) return null;
    const composerDraft = useComposerDraftStore.getState().getComposerDraft(draftId);
    const readCurrentRouting = () => {
      const current = readRouting();
      const latestDraft = getDraftSession(draftId);
      const draftMatches =
        latestDraft === originalDraft ||
        // The picker may fill an empty base while any of the routing reads are pending.
        // Its automatic write keeps the routing mode; a manual pick switches it to manual.
        (originalDraft.envMode === "worktree" &&
          originalDraft.branch === null &&
          latestDraft?.branch != null &&
          shallow(latestDraft, {
            ...originalDraft,
            branch: latestDraft.branch,
            environmentSelection: originalDraft.environmentSelection ?? "auto",
          }));
      return mountedRoutingScope.current === scope &&
        current.input.draftId === draftId &&
        current.input.automaticEnvironment &&
        !current.input.composerHasAttachments &&
        current.input.activeProjectKey === activeProjectKey &&
        current.input.selectedProvider === selectedProvider &&
        current.input.activeProviderInstanceId === activeProviderInstanceId &&
        current.input.loadBalancingSettings.loadBalancingWeights ===
          loadBalancingSettings.loadBalancingWeights &&
        current.loadBalancingCandidates.join("\n") === loadBalancingCandidates.join("\n") &&
        draftMatches &&
        useComposerDraftStore.getState().getComposerDraft(draftId) === composerDraft
        ? current
        : null;
    };
    return loadBalancing.refreshSelection(loadBalancingCandidates).then(async (environmentId) => {
      const current = readCurrentRouting();
      if (!current) return false;
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
      const moved = changesProject(originalDraft, projectRef);
      const workspace = moved ? await readDestinationWorkspace(originalDraft, projectRef) : {};
      const isWorktree = (workspace.envMode ?? originalDraft.envMode) === "worktree";
      const branch =
        isWorktree && (moved || originalDraft.branch === null)
          ? await readWorktreeBase(projectRef, originalDraft.branch)
          : moved
            ? null
            : originalDraft.branch;
      if (
        !readCurrentRouting()?.input.logicalProjectEnvironments.some(
          (candidate) =>
            candidate.environmentId === environmentId && candidate.projectId === target.projectId,
        )
      )
        return false;

      carryFanoutSelections(originalDraft, target.environmentId);
      // The send must read the target project's composer and provider context after retargeting.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "auto",
          loadBalancedEnvironmentId: target.environmentId,
          ...workspace,
          branch,
        }),
      );
      return true;
    });
  };
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (
      !needsLoadBalancing ||
      loadBalancing.pending ||
      !draftId ||
      isEnvironmentChanging ||
      sendInFlightRef.current
    )
      return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    const draft = getDraftSession(draftId);
    if (!draft) return;
    const projectRef = scopeProjectRef(target.environmentId, target.projectId);
    carryFanoutSelections(draft, target.environmentId);
    setDraftThreadContext(draftId, {
      projectRef,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
    if (changesProject(draft, projectRef)) {
      const current = { envMode: draft.envMode, startFromOrigin: draft.startFromOrigin };
      trackPendingWorkspaceDefault(
        draftId,
        projectRef,
        current,
        readDestinationWorkspace(draft, projectRef).then((workspace) => ({
          ...current,
          ...workspace,
        })),
      );
    }
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    isEnvironmentChanging,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
  ]);
  // A change in flight belongs to the draft and project it started on.
  const environmentChangeRef = useRef<{
    readonly controller: AbortController;
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
        environmentChangeRef.current.controller.abort();
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  const onAutoEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: m(msg("Keep attachments on this machine")),
        description: m(
          msg(
            "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
          ),
        ),
      });
      return;
    }
    environmentChangeRef.current?.controller.abort();
    environmentChangeRef.current = null;
    setBusyEnvironmentChange(null);
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
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? gt("Auto balance")
      : loadBalancing.pending
        ? gt("Checking machines…")
        : loadBalancing.failed
          ? gt("Auto balance unavailable")
          : gt("Auto balance")
    : undefined;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target) return;
    environmentChangeRef.current?.controller.abort();
    const request = {
      controller: new AbortController(),
      environmentId: target.environmentId,
      scope: environmentChangeScope,
    };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const readSwitchingDraft = () => {
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
        return null;
      return currentDraft;
    };
    // `triagePrompt` is the prompt the target machine prepared for a triage draft.
    const retarget = async (
      project: (typeof allProjects)[number],
      triagePrompt?: string,
    ): Promise<void> => {
      const draft = readSwitchingDraft();
      if (!draft) return;
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      // Use the catalog-backed list: an unpaired machine can still have a cached project snapshot.
      const findDestination = (projects: typeof allProjects) =>
        projects.find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
      const workspaceRoot = findDestination(readProjects())?.workspaceRoot;
      const controller = new AbortController();
      const unsubscribe = subscribeProjects((projects) => {
        if (findDestination(projects)?.workspaceRoot !== workspaceRoot) controller.abort();
      });
      const workspaceRead =
        workspaceRoot === undefined
          ? Promise.resolve({})
          : retargetDraftWorkspace(
              draft,
              projectRef,
              AbortSignal.any([request.controller.signal, controller.signal]),
            );
      const defaultWorkspace = await workspaceRead.finally(unsubscribe);
      const currentDraft = readSwitchingDraft();
      if (!currentDraft) return;
      const destination = findDestination(readProjects());
      if (!destination) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not switch machine")),
            description: m(msg("This project is no longer available.")),
          }),
        );
        return;
      }
      if (controller.signal.aborted || destination.workspaceRoot !== workspaceRoot) {
        return retarget(destination, triagePrompt);
      }
      const workspace =
        currentDraft.workspaceExplicit || currentDraft.worktreePath !== null
          ? {}
          : defaultWorkspace;
      if (triagePrompt !== undefined) {
        // Read now, so text typed while the machine prepared the session is kept.
        const prompt = getComposerDraft(draftId)?.prompt ?? "";
        const nextPrompt = replaceTriagePlaybookLink(prompt, triagePrompt);
        if (nextPrompt !== prompt) setPrompt(draftId, nextPrompt);
      }
      carryFanoutSelections(currentDraft, target.environmentId);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(destination, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null, ...workspace },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
          ...workspace,
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
    if (target.projectId !== null && !knownProject) {
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
            title: m(msg("Could not switch machine")),
            description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
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
        (await openScratchProject(target.environmentId, m(msg("Could not switch machine"))));
      if (project) await retarget(project, triagePrompt);
    };
    setBusyEnvironmentChange(request);
    void switchMachine().finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    refreshBeforeSend,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
