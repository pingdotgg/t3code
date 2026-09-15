import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { readProjects, readThreadShell, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const router = useRouter();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const ready =
    activation !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: () => {
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
      },
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
      openThread: (projectRef) => openThread(projectRef),
      readThreadShell: (ref) => {
        const shell = readThreadShell(ref);
        if (shell === null) return null;
        return {
          environmentId: shell.environmentId,
          threadId: shell.id,
          projectId: shell.projectId,
          archivedAt: shell.archivedAt,
        };
      },
      navigateToThread: async (ref) => {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
        });
      },
      isThreadRouteActive: (ref) =>
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
        }).pathname === router.state.location.pathname,
      // Optional on purpose: an older desktop shell lacks the probe, so
      // open-thread fails safely instead of assuming the request is live.
      isRequestActive:
        activation?.isRequestActive === undefined
          ? undefined
          : (requestId: string) => activation.isRequestActive!(requestId),
    }),
  );

  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
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
  }, [activation, ready]);

  return null;
}
