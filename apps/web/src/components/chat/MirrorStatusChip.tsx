import type {
  EnvironmentId,
  MirrorProjectStatus,
  ProjectId,
  ProjectOrigin,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon } from "lucide-react";
import { useCallback } from "react";

import { mirrorEnvironment } from "../../state/mirror";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MessageCopyButton } from "./MessageCopyButton";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

const MAX_VISIBLE_CONFLICT_PATHS = 10;

function formatTransferBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** "30%" when the upload size is known, "12 MB" otherwise, null when idle. */
function transferProgressLabel(status: MirrorProjectStatus | null): string | null {
  const transfer = status?.transfer;
  if (transfer === undefined || transfer.bytes <= 0) return null;
  if (transfer.totalBytes !== null && transfer.totalBytes > 0) {
    return `${Math.min(100, Math.round((transfer.bytes / transfer.totalBytes) * 100))}%`;
  }
  return formatTransferBytes(transfer.bytes);
}

export function mirrorStatusChipLabel(status: MirrorProjectStatus | null): string {
  if (status === null) return "Mirror";
  const progress = transferProgressLabel(status);
  const withProgress = (base: string) => (progress === null ? base : `${base} · ${progress}`);
  switch (status.state) {
    case "seeding":
      return withProgress("Seeding");
    case "idle":
      return "Synced";
    case "syncing":
      return withProgress("Syncing");
    case "applying":
      return "Applying";
    case "offline":
      return "Offline";
    case "conflict":
      return `Conflicts (${status.conflictPaths.length})`;
  }
}

function mirrorStatusChipVariant(status: MirrorProjectStatus | null) {
  switch (status?.state) {
    case "conflict":
      return "error" as const;
    case "offline":
      return "warning" as const;
    case "idle":
      return "success" as const;
    case undefined:
      return "outline" as const;
    default:
      return "info" as const;
  }
}

/**
 * Sync-state chip for mirrored projects (project.origin != null): shows the
 * live mirror state next to the project name and opens a popover with the
 * origin machine, last sync time, conflicting files, and a "Sync now" action.
 */
export function MirrorStatusChip({
  environmentId,
  projectId,
  origin,
  workspaceRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly origin: ProjectOrigin;
  /** Host-side mirror directory, when the caller has it. */
  readonly workspaceRoot?: string | null;
}) {
  const statusQuery = useEnvironmentQuery(
    mirrorEnvironment.statusByProject({ environmentId, input: { projectId } }),
  );
  const status = statusQuery.data?.[projectId] ?? null;
  const requestSync = useAtomCommand(mirrorEnvironment.requestSync, {
    reportFailure: false,
  });

  const handleSyncNow = useCallback(async () => {
    const result = await requestSync({ environmentId, input: { projectId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Failed to sync project files",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, [environmentId, projectId, requestSync]);

  const label = mirrorStatusChipLabel(status);
  const originLabel = origin.label ?? origin.environmentId;
  const syncInProgress =
    status?.state === "seeding" || status?.state === "syncing" || status?.state === "applying";
  const conflictPaths = status?.state === "conflict" ? status.conflictPaths : [];
  const visibleConflictPaths = conflictPaths.slice(0, MAX_VISIBLE_CONFLICT_PATHS);
  const hiddenConflictCount = conflictPaths.length - visibleConflictPaths.length;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Badge
            render={<button type="button" aria-label={`Mirror status: ${label}`} />}
            size="sm"
            variant={mirrorStatusChipVariant(status)}
          />
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverPopup align="start" className="max-w-80" side="bottom">
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">Mirrored project</span>
            <span className="text-muted-foreground">Files live on {originLabel}</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 text-muted-foreground">{originLabel}:</span>
              <span className="min-w-0 truncate font-mono text-muted-foreground">
                {origin.rootPath}
              </span>
              <MessageCopyButton
                text={origin.rootPath}
                ariaLabel={`Copy ${originLabel} path`}
                size="icon-xs"
                variant="ghost"
              />
            </div>
            {workspaceRoot != null && workspaceRoot.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-muted-foreground">Mirror:</span>
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {workspaceRoot}
                </span>
                <MessageCopyButton
                  text={workspaceRoot}
                  ariaLabel="Copy mirror path"
                  size="icon-xs"
                  variant="ghost"
                />
              </div>
            ) : null}
          </div>
          {syncInProgress && status?.transfer !== undefined && status.transfer.bytes > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                {status.transfer.totalBytes !== null && status.transfer.totalBytes > 0
                  ? `Transferring ${formatTransferBytes(status.transfer.bytes)} of ${formatTransferBytes(status.transfer.totalBytes)}`
                  : `Transferred ${formatTransferBytes(status.transfer.bytes)}`}
              </span>
              {status.transfer.totalBytes !== null && status.transfer.totalBytes > 0 ? (
                <div
                  aria-hidden
                  className="h-1 w-full overflow-hidden rounded-full bg-muted"
                  data-testid="mirror-transfer-progress"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
                    style={{
                      width: `${Math.min(100, Math.round((status.transfer.bytes / status.transfer.totalBytes) * 100))}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="text-muted-foreground">
            {status?.lastSyncedAt
              ? `Last synced ${formatRelativeTimeLabel(status.lastSyncedAt)}`
              : "Not synced yet"}
          </span>
          {status !== null && !status.originConnected ? (
            <span className="text-warning-foreground">{originLabel} is not connected.</span>
          ) : null}
          {visibleConflictPaths.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">Conflicting files</span>
              <ul className="flex flex-col gap-0.5">
                {visibleConflictPaths.map((path) => (
                  <li key={path} className="truncate font-mono text-muted-foreground">
                    {path}
                  </li>
                ))}
                {hiddenConflictCount > 0 ? (
                  <li className="text-muted-foreground">+{hiddenConflictCount} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}
          <Button
            className="self-start"
            disabled={syncInProgress || status?.originConnected === false}
            onClick={() => {
              void handleSyncNow();
            }}
            size="xs"
            variant="outline"
          >
            <RefreshCwIcon aria-hidden />
            {syncInProgress ? "Sync in progress" : "Sync now"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
