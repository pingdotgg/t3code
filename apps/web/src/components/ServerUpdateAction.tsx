import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type ComponentProps, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand } from "~/versionSkew";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The wire "installing" stage is a sub-second launcher handoff, so the UI
// folds it into the download phase; everything after the handoff is the
// restart the user is actually waiting through.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Downloading…",
  resuming: "Restarting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly desktopAppUpdate?: boolean;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size"> & {
  readonly label?: string;
};

function useServerUpdate() {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  return async (target: ServerUpdateTarget, failureTitle = "Server update failed") => {
    const { environmentId, serverLabel, selfUpdate, targetVersion } = target;
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await updateServer({
        environmentId,
        input: {
          targetVersion,
          ...(target.threadContinuation && target.continueThreadsAfterServerUpdate
            ? { continueRunningThreads: true }
            : {}),
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description:
          selfUpdate === "desktop-managed"
            ? `Desktop app relaunched on ${result.value.targetVersion}.`
            : `Reconnected on t3@${result.value.targetVersion}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: updateFailureMessage(error),
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
}

/** Updates eligible machines independently; manual paths remain in the machine list. */
export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const update = useServerUpdate();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(
    (target) =>
      target.selfUpdate !== null &&
      (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate),
  );
  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const available = eligible.filter(
        (target) => !pendingUpdateEnvironmentIds.has(target.environmentId),
      );
      const desktopTargets = available.filter((target) => target.selfUpdate === "desktop-managed");
      if (desktopTargets.length > 0) {
        const confirmed =
          (await requestConfirmDialog(
            `Update the T3 Code desktop apps on ${desktopTargets.map((target) => target.serverLabel).join(", ")}? They will close and relaunch on those machines.`,
          )) ?? true;
        if (!confirmed) return;
      }
      await Promise.all(
        available.map((target) => update(target, `${target.serverLabel} update failed`)),
      );
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      disabled={isPending || eligible.length === 0}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}

/**
 * One-row status for an in-flight server update: "Downloading…" then
 * "Restarting…". The update is a wait, not a warning: a single pulsing dot
 * and label, no step rail, no versions. Failure turns the row red with the
 * rollback reason.
 */
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top" className="max-w-80">
            {state.message}
          </TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  desktopAppUpdate = false,
  threadContinuation = false,
  targetVersion,
  label = "Update",
  variant = "outline",
  size = "xs",
}: Omit<ServerUpdateTarget, "continueThreadsAfterServerUpdate"> & UpdateButtonProps) {
  const isDesktopAppUpdate = selfUpdate === "desktop-managed";
  const continueThreadsAfterServerUpdate = useEnvironmentSettings(
    environmentId,
    (settings) => settings.continueThreadsAfterServerUpdate,
  );
  const update = useServerUpdate();
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "update command",
    onCopy: ({ command }) => {
      toastManager.add({
        type: "success",
        title: "Update command copied",
        description: `Run \`${command}\` on ${serverLabel} to update it.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy update command",
        description: error.message,
      });
    },
  });

  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) {
      return;
    }
    if (isDesktopAppUpdate) {
      // No themed host mounted (undefined) means proceed: the click itself
      // was the request. This is the only confirmation in the flow; the
      // remote machine installs without asking anyone there.
      const confirmed =
        (await requestConfirmDialog(
          `Update the T3 Code desktop app that runs the ${serverLabel}? It will close and relaunch on that machine.`,
        )) ?? true;
      if (!confirmed) {
        return;
      }
    }
    await update({
      environmentId,
      serverLabel,
      selfUpdate,
      desktopAppUpdate,
      threadContinuation,
      targetVersion,
      continueThreadsAfterServerUpdate,
    });
  };

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  if (selfUpdate === null) {
    const command = manualServerUpdateCommand(targetVersion);
    return (
      <Button size={size} variant={variant} onClick={() => copyToClipboard(command, { command })}>
        Copy update command
      </Button>
    );
  }

  return (
    <Button size={size} variant={variant} onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
