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
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import {
  createKeyedRequestGate,
  isDraftEnvironmentRetargetApplicable,
  planLoadBalancedDraftRetarget,
} from "../ChatView.logic";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { DraftSessionState } from "../../composerDraftStore";

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

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine.
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
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = needsLoadBalancing
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
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isManualEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  // At most one automatic scratch-project open per `${draftId}:${environmentId}`. A
  // settled (even failed) key stays active so it is not retried until the target
  // changes or the user re-arms Auto; any other target cancels it.
  const [autoScratchRequest] = useState(createKeyedRequestGate);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels an automatic scratch open still in flight on unmount
  useLayoutEffect(() => () => autoScratchRequest.cancel(), [autoScratchRequest]);
  const autoScratchTarget = logicalProjectEnvironments.find(
    (environment) => environment.environmentId === loadBalancing.environmentId,
  );
  const autoScratchPlan = planLoadBalancedDraftRetarget({
    needsLoadBalancing,
    loadBalancingPending: loadBalancing.pending,
    draftId,
    target: autoScratchTarget,
  });
  const autoScratchRequestKey =
    activeProjectIsScratch && draftId && autoScratchPlan?.kind === "open-scratch"
      ? `${draftId}:${autoScratchPlan.environmentId}`
      : null;
  const [settledAutoScratchKey, setSettledAutoScratchKey] = useState<string | null>(null);
  // A new target cancels the old open, so a return to an earlier target opens it again.
  const [seenAutoScratchKey, setSeenAutoScratchKey] = useState(autoScratchRequestKey);
  if (seenAutoScratchKey !== autoScratchRequestKey) {
    setSeenAutoScratchKey(autoScratchRequestKey);
    setSettledAutoScratchKey(null);
  }
  const isEnvironmentChanging =
    isManualEnvironmentChanging ||
    (autoScratchRequestKey !== null && settledAutoScratchKey !== autoScratchRequestKey);
  // Invalidate before passive effects, without mutating request state during render.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a scratch open whose target the routing moved away from
  useLayoutEffect(
    () => autoScratchRequest.sync(autoScratchRequestKey),
    [autoScratchRequest, autoScratchRequestKey],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    // A manual machine pick still opening its scratch project wins over Auto.
    const plan = sendInFlightRef.current || isManualEnvironmentChanging ? null : autoScratchPlan;
    if (!plan || !draftId) return;
    // A scratch draft moves its logical-project mapping with the machine: each
    // environment's scratch project is its own logical project.
    const retargetScratchDraft = (project: (typeof allProjects)[number]) => {
      setLogicalProjectDraftThreadId(
        deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
        scopeProjectRef(plan.environmentId, project.id),
        draftId,
        { environmentSelection: "auto", loadBalancedEnvironmentId: plan.environmentId },
      );
    };
    if (plan.kind === "retarget") {
      if (!activeProjectIsScratch) {
        setDraftThreadContext(draftId, {
          projectRef: scopeProjectRef(plan.environmentId, plan.projectId),
          environmentSelection: "auto",
          loadBalancedEnvironmentId: plan.environmentId,
        });
        return;
      }
      const project = allProjects.find(
        (candidate) =>
          candidate.environmentId === plan.environmentId && candidate.id === plan.projectId,
      );
      if (project) retargetScratchDraft(project);
      return;
    }
    if (!autoScratchRequestKey) return;
    // The chosen machine has no scratch project yet: open it first and retarget
    // only on success, so a send can never slip out on the machine the draft
    // started on. The send path stays blocked while loadBalancedEnvironmentId is
    // unresolved.
    const snapshot = getDraftSession(draftId);
    if (!snapshot || snapshot.promotedTo) return;
    const token = autoScratchRequest.begin(autoScratchRequestKey);
    if (token === null) return;
    const requestKey = autoScratchRequestKey;
    void openScratchProject(plan.environmentId, "Could not prepare machine")
      .then((project) => {
        if (
          !project ||
          !autoScratchRequest.isCurrent(token) ||
          !isDraftEnvironmentRetargetApplicable({
            snapshot,
            current: getDraftSession(draftId),
            sendInFlight: sendInFlightRef.current,
            requireUnresolvedAuto: true,
          })
        ) {
          return;
        }
        retargetScratchDraft(project);
      })
      .finally(() => {
        if (autoScratchRequest.isCurrent(token)) setSettledAutoScratchKey(requestKey);
      });
  }, [
    autoScratchPlan,
    autoScratchRequestKey,
    autoScratchRequest,
    isManualEnvironmentChanging,
    draftId,
    activeProjectIsScratch,
    allProjects,
    projectGroupingSettings,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
    setLogicalProjectDraftThreadId,
    openScratchProject,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId) return;
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
    // Re-arming Auto retries a previously failed or superseded scratch open.
    autoScratchRequest.cancel();
    setSettledAutoScratchKey(null);
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
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

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
    autoScratchRequest.cancel();
    setBusyEnvironmentChange(null);
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        !isDraftEnvironmentRetargetApplicable({
          snapshot: originalDraft,
          current: currentDraft,
          sendInFlight: sendInFlightRef.current,
        })
      )
        return;
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
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    setBusyEnvironmentChange(request);
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then((project) => {
        if (project) retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  return {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
