import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { deriveWorkspaceOptions } from "../components/BranchToolbar.logic";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readThreadShell, useProjects, useServerConfigs, useThread } from "../state/entities";
import { useBranches } from "../state/queries";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { vcsEnvironment } from "../state/vcs";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

export function useNewThreadHandler() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        replace?: boolean;
      },
    ): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const environmentSettings =
        serverConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThreadRef && readThreadShell(storedDraftThreadRef) !== null
          ? null
          : storedDraftThread;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (reusableStoredDraftThread) {
        return (async () => {
          if (
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption
          ) {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
              ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
            });
          }
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
            },
          );
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: reusableStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
        });
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const initialEnvMode = options?.envMode ?? environmentSettings.defaultThreadEnvMode;
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: environmentSettings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(draftId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
      })();
    },
    [getCurrentRouteTarget, projectGroupingSettings, projects, router, serverConfigs],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const listRefs = useAtomQueryRunner(vcsEnvironment.listRefs, {
    reportFailure: false,
  });
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();
  const defaultProjectRef = orderedProjects[0]
    ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
    : null;
  const newThreadProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : activeDraftThread
      ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
      : defaultProjectRef;
  const newThreadProject = newThreadProjectRef
    ? projects.find(
        (project) =>
          project.environmentId === newThreadProjectRef.environmentId &&
          project.id === newThreadProjectRef.projectId,
      )
    : undefined;
  const activeProjectBranches = useBranches({
    environmentId: newThreadProject?.environmentId ?? null,
    cwd: newThreadProject?.workspaceRoot ?? null,
  });
  const activeProjectMainCheckout = useMemo(() => {
    if (!newThreadProject || !activeProjectBranches.data) return undefined;
    const workspaceOptions = deriveWorkspaceOptions(
      activeProjectBranches.data.refs,
      newThreadProject.workspaceRoot,
    );
    if (workspaceOptions.mainCheckout) return workspaceOptions.mainCheckout;
    const defaultRef = activeProjectBranches.data.refs.find(
      (ref) => !ref.isRemote && ref.isDefault,
    );
    return defaultRef ? { branch: defaultRef.name, path: null } : undefined;
  }, [activeProjectBranches.data, newThreadProject]);
  const resolveDefaultMainCheckout = useCallback(
    async (projectRef: ScopedProjectRef) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === projectRef.environmentId &&
          candidate.id === projectRef.projectId,
      );
      if (!project) return undefined;

      if (
        newThreadProjectRef !== null &&
        projectRef.environmentId === newThreadProjectRef.environmentId &&
        projectRef.projectId === newThreadProjectRef.projectId
      ) {
        return activeProjectMainCheckout;
      }

      const result = await listRefs({
        environmentId: projectRef.environmentId,
        input: { cwd: project.workspaceRoot, limit: 100 },
      });
      if (result._tag === "Failure") return activeProjectMainCheckout;

      const workspaceOptions = deriveWorkspaceOptions(result.value.refs, project.workspaceRoot);
      if (workspaceOptions.mainCheckout) return workspaceOptions.mainCheckout;

      const defaultRef = result.value.refs.find((ref) => !ref.isRemote && ref.isDefault);
      return defaultRef ? { branch: defaultRef.name, path: null } : undefined;
    },
    [activeProjectMainCheckout, listRefs, newThreadProjectRef, projects],
  );
  const defaultProjectSettings = useMemo(() => {
    if (newThreadProjectRef === null) {
      return DEFAULT_SERVER_SETTINGS;
    }
    return (
      serverConfigs.get(newThreadProjectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS
    );
  }, [newThreadProjectRef, serverConfigs]);
  const resolveNewThreadDefaults = useCallback(
    (projectRef: ScopedProjectRef) => {
      const settings =
        serverConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      return {
        envMode: settings.defaultThreadEnvMode,
        newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
      };
    },
    [serverConfigs],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    defaultThreadEnvMode: defaultProjectSettings.defaultThreadEnvMode,
    defaultNewWorktreesStartFromOrigin: defaultProjectSettings.newWorktreesStartFromOrigin,
    handleNewThread,
    resolveDefaultMainCheckout,
    resolveNewThreadDefaults,
    routeThreadRef,
  };
}
