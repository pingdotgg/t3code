import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useDraftSendOnOpenStore } from "~/draftSendOnOpenStore";
import { projectEnvironment } from "~/state/projects";
import { type NewThreadHandler, useNewThreadHandler } from "./useHandleNewThread";

// The server offers no scratch folder when its data dir sits in a git work tree.
const SCRATCH_UNAVAILABLE_REASON = "Off on this server: its data folder is inside a git repo";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

type ScratchEnvironment = Pick<EnvironmentPresentation, "connection" | "serverConfig"> & {
  readonly environmentId: EnvironmentId;
};

export function createScratchProjectActions(input: {
  readonly environments: () => Iterable<ScratchEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly handleNewThread: NewThreadHandler;
}) {
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    let environment: ScratchEnvironment | undefined;
    for (const entry of input.environments()) {
      if (entry.environmentId === environmentId) environment = entry;
    }
    return availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig);
  };

  /**
   * Why "No project" is off for a connected environment whose config came
   * without a scratch folder; null while it is available or still loading.
   */
  const scratchUnavailableReason = (environmentId: EnvironmentId | null): string | null => {
    const environment = [...input.environments()].find(
      (entry) => entry.environmentId === environmentId,
    );
    return environment?.connection.phase === "connected" &&
      environment.serverConfig !== null &&
      environment.serverConfig.scratchWorkspaceRoot === undefined
      ? SCRATCH_UNAVAILABLE_REASON
      : null;
  };

  // The primary (local) environment wins; `fallback` only applies when it offers no scratch root.
  const scratchEnvironmentId = (fallback: EnvironmentId | null): EnvironmentId | null => {
    const primary = input.primaryEnvironmentId();
    if (primary !== null && scratchWorkspaceRootFor(primary) !== null) return primary;
    if (fallback !== null && scratchWorkspaceRootFor(fallback) !== null) return fallback;
    const offering = [...input.environments()].filter(
      (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
    );
    return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
  };

  const openScratchProject = async (
    environmentId: EnvironmentId,
    failureTitle = "Could not start without a project",
  ): Promise<EnvironmentProject | null> => {
    const command = projectEnvironment.openScratch;
    const result = await runAtomCommand(
      input.registry,
      command,
      { environmentId, input: {} },
      { label: command.label, reportFailure: false, reportDefect: true },
    );
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
    }
    return null;
  };

  /**
   * Opens a draft without a project. With `sendCarriedDraft`, the message
   * typed on the no-projects home moves into it and sends from there.
   */
  const startScratchThread = async (
    environmentId: EnvironmentId,
    options?: { sendCarriedDraft?: boolean },
  ) => {
    // Armed before the project exists, so the draft's move sends however it opens.
    if (options?.sendCarriedDraft) useDraftSendOnOpenStore.setState({ armed: true });
    const project = await openScratchProject(environmentId);
    if (!project) {
      useDraftSendOnOpenStore.setState({ armed: false });
      return;
    }
    await input
      .handleNewThread(scopeProjectRef(project.environmentId, project.id))
      .catch((error: unknown) => reportScratchFailure("Could not start without a project", error));
  };

  return {
    scratchWorkspaceRootFor,
    scratchEnvironmentId,
    scratchUnavailableReason,
    openScratchProject,
    startScratchThread,
  };
}

export function useScratchProject() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const handleNewThread = useNewThreadHandler();
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    registry,
    handleNewThread,
  });
}
