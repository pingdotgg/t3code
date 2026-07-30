import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand } from "~/versionSkew";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const UPDATE_STEPS = [
  { stage: "downloading", label: "Download" },
  { stage: "installing", label: "Install" },
  { stage: "resuming", label: "Resume" },
] as const;
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

function updateStatusCopy(
  state: Exclude<ServerUpdateState, { status: "idle" }>,
  serverLabel: string,
): string {
  if (state.status === "failed") {
    return state.message;
  }
  switch (state.stage) {
    case "downloading":
      return "Downloading the matching server version.";
    case "installing":
      return `Installing and verifying t3@${state.targetVersion}.`;
    case "resuming":
      return `Waiting for ${serverLabel} to accept commands.`;
  }
}

export function ServerUpdateProgress({
  fromVersion,
  serverLabel,
  state,
}: {
  readonly fromVersion: string;
  readonly serverLabel: string;
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  const currentIndex = UPDATE_STEPS.findIndex(({ stage }) => stage === state.stage);

  return (
    <div className="mt-1 min-w-0 space-y-2.5">
      <p className="text-xs text-muted-foreground">
        {fromVersion} <span aria-hidden="true">→</span> {state.targetVersion}
      </p>
      <ol className="flex min-w-0 items-center" aria-label="Server update progress">
        {UPDATE_STEPS.map((step, index) => {
          const complete = index < currentIndex;
          const current = index === currentIndex;
          const failed = current && state.status === "failed";
          return (
            <li
              key={step.stage}
              className={cn(
                "flex min-w-0 items-center text-xs font-medium",
                index < UPDATE_STEPS.length - 1 ? "flex-1" : null,
                complete
                  ? "text-success"
                  : failed
                    ? "text-destructive"
                    : current
                      ? "text-primary"
                      : "text-muted-foreground/60",
              )}
              aria-current={current && state.status === "running" ? "step" : undefined}
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-full border",
                  complete
                    ? "border-success bg-success text-success-foreground"
                    : failed
                      ? "border-destructive bg-destructive text-destructive-foreground"
                      : current
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/35",
                )}
                aria-hidden="true"
              >
                {complete ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
              </span>
              <span className="ml-1.5 truncate">{step.label}</span>
              {index < UPDATE_STEPS.length - 1 ? (
                <span
                  className={cn(
                    "mx-2 h-px min-w-3 flex-1",
                    complete ? "bg-success/60" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p
        className={cn(
          "text-xs",
          state.status === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
        role={state.status === "failed" ? "alert" : "status"}
      >
        {updateStatusCopy(state, serverLabel)}
      </p>
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
  targetVersion,
  label = "Update server",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
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
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await updateServer({
        environmentId,
        input: { targetVersion },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "Server update failed",
          description: updateFailureMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description: `Reconnected on t3@${result.value.targetVersion}.`,
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };

  if (selfUpdate === "desktop-managed") {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  if (selfUpdate === null) {
    const command = manualServerUpdateCommand(targetVersion);
    return (
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(command, { command })}>
        Copy update command
      </Button>
    );
  }

  return (
    <Button size="xs" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
