import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopAppActivationRequest } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { Atom } from "effect/reactivity";

import {
  resolveDesktopActivationTarget,
  handleDesktopAppActivationRequest,
  openedProjectDraft,
  desktopAppActivationPendingAtom,
} from "../../desktopAppActivation";
import { useComposerDraftStore } from "../../composerDraftStore";
import { desktopLocalBackendId } from "../../connection/desktopLocal";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { newProjectId } from "../../lib/utils";
import { readProjects, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { environmentShell } from "../../state/shell";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { reportProjectFailure } from "../../hooks/useProjectGroupUpdate";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { resolveThreadRouteTarget } from "../../threadRoutes";

export function DesktopAppActivationCoordinator() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const openThread = useNewThreadHandler();
  const router = useRouter();
  const queueRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);
  const activation = window.desktopBridge?.appActivation;
  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: async (request) => {
        const targetAtom = Atom.make((get) => {
          const primaryId = get(primaryEnvironmentIdAtom);
          const presentations = get(environmentPresentations.presentationsAtom);
          let bootstraps: ReturnType<
            NonNullable<typeof window.desktopBridge>["getLocalEnvironmentBootstraps"]
          > = [];
          if (request.wslDistro !== undefined) {
            try {
              bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
            } catch {
              return null;
            }
          }
          return resolveDesktopActivationTarget(
            request,
            primaryId,
            [...presentations].map(([environmentId, environment]) => ({
              environmentId,
              backendId:
                environmentId === primaryId
                  ? PRIMARY_LOCAL_ENVIRONMENT_ID
                  : desktopLocalBackendId(environment.entry.target),
              connected: environment.connection.phase === "connected",
              platform: environment.serverConfig?.environment.platform.os ?? null,
            })),
            bootstraps,
          );
        });
        const ready = await waitForAtomValue({
          registry: appAtomRegistry,
          atom: targetAtom,
          predicate: (target) => target !== null,
          timeoutMs: 5_000,
        });
        return ready ? appAtomRegistry.get(targetAtom) : null;
      },
      waitForSnapshot: (environmentId) =>
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentShell.statusAtom(environmentId),
          predicate: (status) => status === "live",
          timeoutMs: 5_000,
        }),
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: async (projectRef) => {
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
        // Opening an archived project's folder again brings the project back.
        if (project?.archivedAt != null) {
          void updateProject({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, archived: false },
          }).then((result) => reportProjectFailure("Failed to unarchive project", result));
        }
        const opened = await openThread(projectRef);
        if (opened !== null) return opened;
        const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
        const target = resolveThreadRouteTarget(params);
        return openedProjectDraft(
          projectRef,
          target?.kind === "draft"
            ? useComposerDraftStore.getState().getDraftSession(target.draftId)
            : null,
        );
      },
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop activation requests over the bridge and marks the renderer ready
  useEffect(() => {
    if (activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      pendingRef.current += 1;
      appAtomRegistry.set(desktopAppActivationPendingAtom, true);
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current
        .catch(() => undefined)
        .finally(() => {
          pendingRef.current -= 1;
          if (pendingRef.current === 0) appAtomRegistry.set(desktopAppActivationPendingAtom, false);
        });
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation]);

  return null;
}
