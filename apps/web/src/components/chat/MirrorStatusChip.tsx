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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

const MAX_VISIBLE_CONFLICT_PATHS = 10;

export function mirrorStatusChipLabel(status: MirrorProjectStatus | null): string {
  if (status === null) return "Mirror";
  switch (status.state) {
    case "seeding":
      return "Seeding";
    case "idle":
      return "Synced";
    case "syncing":
      return "Syncing";
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
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly origin: ProjectOrigin;
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
            <span className="text-muted-foreground">
              Files live on {originLabel} at {origin.rootPath}
            </span>
          </div>
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
