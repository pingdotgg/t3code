import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function reportScratchFailure(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not open Scratch",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Scratch runs threads in a plain folder the server owns instead of a
 * repository. The server creates the Scratch project on first use; after that
 * it is an ordinary project on the non-git path.
 */
export function useScratchProject() {
  const { environments } = useEnvironments();
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  /** The Scratch folder of a connected environment, or null when it offers none. */
  const scratchWorkspaceRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null => {
      const environment = environments.find((entry) => entry.environmentId === environmentId);
      return environment?.connection.phase === "connected"
        ? (environment.serverConfig?.scratchWorkspaceRoot ?? null)
        : null;
    },
    [environments],
  );

  // The hosted web app has no primary environment, so Scratch falls back to
  // the first connected environment that offers it.
  const scratchEnvironmentId = useCallback(
    (preferred: EnvironmentId | null): EnvironmentId | null =>
      scratchWorkspaceRootFor(preferred) !== null
        ? preferred
        : (environments.find((entry) => scratchWorkspaceRootFor(entry.environmentId) !== null)
            ?.environmentId ?? null),
    [environments, scratchWorkspaceRootFor],
  );

  /** Resolves to the Scratch project once it is in this client's store. */
  const openScratchProject = useCallback(
    async (environmentId: EnvironmentId): Promise<EnvironmentProject | null> => {
      const result = await ensureScratch({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportScratchFailure(squashAtomCommandFailure(result));
        }
        return null;
      }
      // Drafts key off the project's stored path and settings, so wait for
      // the create event to reach the store before targeting one.
      return waitForProject(scopeProjectRef(environmentId, result.value.projectId)).catch(
        (error: unknown) => {
          reportScratchFailure(error);
          return null;
        },
      );
    },
    [ensureScratch],
  );

  const startScratchThread = useCallback(
    async (environmentId: EnvironmentId) => {
      const project = await openScratchProject(environmentId);
      if (project) {
        await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
          reportScratchFailure,
        );
      }
    },
    [handleNewThread, openScratchProject],
  );

  return { scratchWorkspaceRootFor, scratchEnvironmentId, openScratchProject, startScratchThread };
}
