import { useParams } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  projectCloneDisplayName,
  projectCloneProgressSummary,
  type EnvironmentId,
  type ProjectCloneSnapshot,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import { useEnvironments } from "../state/environments";
import { useEnvironmentProjectClones } from "../state/projectClones";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

/**
 * One toast per clone in flight, on every environment. The palette that
 * started a clone closes right away, so this is where its progress lives:
 * the toast updates in place as git reports stages, then settles into a
 * success or failure state with the matching action.
 */
export function ProjectCloneToastCoordinator() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentCloneToasts
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}

interface TrackedToast {
  readonly toastId: ReturnType<typeof toastManager.add>;
  /** The last snapshot rendered, so an identical redraw does not touch the toast. */
  readonly renderedKey: string;
  readonly phase: ProjectCloneSnapshot["phase"];
}

function renderKey(clone: ProjectCloneSnapshot): string {
  return `${clone.phase}:${clone.stage}:${clone.percent ?? ""}:${clone.detail ?? ""}:${clone.error ?? ""}`;
}

function EnvironmentCloneToasts({ environmentId }: { environmentId: EnvironmentId }) {
  const clones = useEnvironmentProjectClones(environmentId);
  const handleNewThread = useNewThreadHandler();
  const { draftId: routeDraftId } = useParams({ strict: false });
  const cancelClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();
  const toasts = useRef(new Map<ProjectId, TrackedToast>());

  // Whether the user is already looking at this project's draft: the composer
  // banner shows the same progress and actions there, so the toast steps
  // aside and comes back if they navigate away mid-clone.
  const isViewingProjectDraft = useCallback(
    (projectId: ProjectId) => {
      if (!routeDraftId) return false;
      const draft = useComposerDraftStore.getState().getDraftSession(routeDraftId as DraftId);
      return draft?.environmentId === environmentId && draft.projectId === projectId;
    },
    [environmentId, routeDraftId],
  );

  const openProject = useCallback(
    (projectId: ProjectId) => {
      void handleNewThread(scopeProjectRef(environmentId, projectId));
    },
    [environmentId, handleNewThread],
  );

  useEffect(() => {
    const seen = new Set<ProjectId>();
    for (const clone of clones) {
      seen.add(clone.projectId);
      const key = renderKey(clone);
      const tracked = toasts.current.get(clone.projectId);
      const name = projectCloneDisplayName(clone);
      // Handlers run later than this pass, so they look the toast up then.
      const closeToast = () => {
        const current = toasts.current.get(clone.projectId);
        if (!current) return;
        toastManager.close(current.toastId);
        toasts.current.delete(clone.projectId);
      };
      if (isViewingProjectDraft(clone.projectId)) {
        closeToast();
        continue;
      }
      if (tracked?.renderedKey === key) continue;

      if (clone.phase === "running") {
        const options = stackedThreadToast({
          type: "loading",
          title: `Cloning ${name}`,
          description: projectCloneProgressSummary(clone),
          timeout: 0,
          actionProps: {
            children: "Cancel",
            onClick: () => {
              void cancelClone({ environmentId, input: { projectId: clone.projectId } });
            },
          },
          data: { hideCopyButton: true },
        });
        if (tracked) {
          toastManager.update(tracked.toastId, options);
          toasts.current.set(clone.projectId, { ...tracked, renderedKey: key, phase: "running" });
        } else {
          const toastId = toastManager.add(options);
          toasts.current.set(clone.projectId, { toastId, renderedKey: key, phase: "running" });
        }
        continue;
      }

      if (clone.phase === "done") {
        const options = stackedThreadToast({
          type: "success",
          title: `Cloned ${name}`,
          description: clone.destinationPath,
          timeout: 8_000,
          actionProps: {
            children: "Open project",
            onClick: () => {
              closeToast();
              openProject(clone.projectId);
            },
          },
          data: { hideCopyButton: true },
        });
        if (tracked) {
          toastManager.update(tracked.toastId, options);
          toasts.current.set(clone.projectId, { ...tracked, renderedKey: key, phase: "done" });
        } else {
          const toastId = toastManager.add(options);
          toasts.current.set(clone.projectId, { toastId, renderedKey: key, phase: "done" });
        }
        continue;
      }

      // Failed or cancelled: the project stays, pointing at an empty folder.
      // Retry from here; the draft's composer banner offers the same.
      const cancelled = clone.phase === "cancelled";
      const options = stackedThreadToast({
        type: cancelled ? "info" : "error",
        title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
        description: cancelled ? clone.destinationPath : (clone.error ?? "The clone failed."),
        timeout: 0,
        actionProps: {
          children: "Retry",
          onClick: () => {
            void retryClone({ environmentId, input: { projectId: clone.projectId } });
          },
        },
        data: {
          ...(cancelled ? { hideCopyButton: true } : {}),
          secondaryActionProps: {
            children: "Remove project",
            onClick: () => {
              // The server drops the clone with the project, which closes
              // this toast; a failed removal leaves it (and Retry) in place.
              void removeClonedProject({ environmentId, projectId: clone.projectId });
            },
          },
        },
      });
      if (tracked) {
        toastManager.update(tracked.toastId, options);
        toasts.current.set(clone.projectId, { ...tracked, renderedKey: key, phase: clone.phase });
      } else {
        const toastId = toastManager.add(options);
        toasts.current.set(clone.projectId, { toastId, renderedKey: key, phase: clone.phase });
      }
    }

    // A clone the server stopped tracking (done and expired, or its project
    // was removed) takes its toast with it, unless it already settled into a
    // timed success toast that dismisses itself.
    for (const [projectId, tracked] of toasts.current) {
      if (seen.has(projectId)) continue;
      if (tracked.phase !== "done") toastManager.close(tracked.toastId);
      toasts.current.delete(projectId);
    }
  }, [
    cancelClone,
    clones,
    environmentId,
    isViewingProjectDraft,
    openProject,
    removeClonedProject,
    retryClone,
  ]);

  useEffect(
    () => () => {
      for (const tracked of toasts.current.values()) toastManager.close(tracked.toastId);
      toasts.current.clear();
    },
    [],
  );

  return null;
}
