import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  SCRATCH_BLOCKED_HELP_URL,
  type ScratchBlockedByRepository,
  scratchBlockedMessage,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { type NewThreadHandler, useNewThreadHandler } from "./useHandleNewThread";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

const openScratchBlockedHelp = () =>
  void readLocalApi()
    ?.shell.openExternal(SCRATCH_BLOCKED_HELP_URL)
    .catch(() => undefined);

let scratchBlockedToastId: ReturnType<typeof toastManager.add> | undefined;

function reportScratchBlocked(blocked: ScratchBlockedByRepository) {
  // The toast stays until dismissed, so a repeated shortcut replaces it instead of stacking.
  if (scratchBlockedToastId !== undefined) toastManager.close(scratchBlockedToastId);
  const id = toastManager.add(
    stackedThreadToast({
      // Nothing failed: the server turned this off on purpose, and a warning shows the reason in full.
      type: "warning",
      title: "Can't start a thread without a project",
      description: scratchBlockedMessage(blocked),
      timeout: 0,
      actionProps: {
        children: "How to fix",
        onClick: () => {
          toastManager.close(id);
          openScratchBlockedHelp();
        },
      },
    }),
  );
  scratchBlockedToastId = id;
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

  const scratchBlockedFor = (
    environmentId: EnvironmentId | null,
  ): ScratchBlockedByRepository | null => {
    for (const entry of input.environments()) {
      if (entry.environmentId === environmentId && entry.connection.phase === "connected") {
        return entry.serverConfig?.scratchBlockedByRepository ?? null;
      }
    }
    return null;
  };

  // The reason to show when no machine can start one. Only the primary or `fallback` machine
  // counts, since the wording says "this machine".
  const scratchBlocked = (fallback: EnvironmentId | null): ScratchBlockedByRepository | null => {
    for (const entry of input.environments()) {
      if (scratchWorkspaceRootFor(entry.environmentId) !== null) return null;
    }
    return scratchBlockedFor(input.primaryEnvironmentId()) ?? scratchBlockedFor(fallback);
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

  const startScratchThread = async (environmentId: EnvironmentId) => {
    const project = await openScratchProject(environmentId);
    if (project) {
      await input
        .handleNewThread(scopeProjectRef(project.environmentId, project.id))
        .catch((error: unknown) =>
          reportScratchFailure("Could not start without a project", error),
        );
    }
  };

  // Entry points stay visible on a blocked machine, so picking one says why.
  const startScratchThreadOrExplain = async (
    environmentId: EnvironmentId | null,
    blocked: ScratchBlockedByRepository | null,
  ) => {
    if (environmentId !== null) await startScratchThread(environmentId);
    else if (blocked !== null) reportScratchBlocked(blocked);
  };

  return {
    scratchWorkspaceRootFor,
    scratchEnvironmentId,
    scratchBlockedFor,
    scratchBlocked,
    openScratchBlockedHelp,
    openScratchProject,
    startScratchThread,
    startScratchThreadOrExplain,
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
