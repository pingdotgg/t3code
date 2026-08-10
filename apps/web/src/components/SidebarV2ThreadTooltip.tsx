import {
  CircleAlertIcon,
  ClockIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { sanitizeThreadErrorMessage } from "../rpc/transportError";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { SidebarThreadSummary } from "../types";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { prStatusIndicator } from "./ThreadStatusIndicators";
import { TooltipPopup } from "./ui/tooltip";

export function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

/** Remote rows name their environment; primary-environment rows stay unlabelled
    so the common case spends no space on it. */
export function useThreadEnvironmentLabel(thread: SidebarThreadSummary): {
  readonly isRemote: boolean;
  readonly environmentLabel: string | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemote = primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteRuntimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  return {
    isRemote,
    environmentLabel: isRemote ? (remoteRuntimeLabel ?? remoteSavedLabel ?? "Remote") : null,
  };
}

export function ThreadDetailsTooltip({
  thread,
  projectName,
  projectCwd,
  environmentLabel,
  providerEntry,
  terminalProcessCount,
}: {
  readonly thread: SidebarThreadSummary;
  readonly projectName: string;
  readonly projectCwd: string | null;
  readonly environmentLabel: string | null;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? thread.session?.provider ?? null;
  const prStatus = prStatusIndicator(thread.pullRequest);
  // Transport drops are connection noise, not a thread failure; the same
  // sanitizer the chat surface uses keeps them out of the tooltip.
  const sessionError = sanitizeThreadErrorMessage(thread.session?.lastError);
  return (
    <TooltipPopup align="start" className="max-w-80 whitespace-normal text-left" side="right">
      <div className="flex min-w-0 max-w-80 flex-col gap-2 px-0.5 py-1.5">
        <div className="min-w-0 truncate text-xs font-medium leading-none text-foreground">
          {thread.title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <ProjectFavicon
              className="size-3 shrink-0"
              cwd={projectCwd ?? ""}
              environmentId={thread.environmentId}
            />
            <div className="min-w-0 truncate text-foreground/75">{projectName}</div>
          </div>
          {projectCwd ? (
            <div className="min-w-0 truncate pl-5 text-foreground/60">
              {thread.worktreePath ?? projectCwd}
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{thread.branch}</div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                displayName={providerEntry?.displayName ?? driverKind}
                driverKind={driverKind}
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">
                {providerEntry?.displayName ?? driverKind}
              </div>
            </div>
          ) : null}
          {terminalProcessCount > 0 ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
            </div>
          ) : null}
          {prStatus ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitPullRequestIcon className={`size-3 shrink-0 ${prStatus.colorClass}`} />
              <div className="min-w-0 truncate text-foreground/75">{prStatus.tooltip}</div>
            </div>
          ) : null}
          {/* The row itself only reveals its timestamp on hover, so the tooltip
              is where "when was this last touched" always lives. */}
          <div className="flex min-w-0 items-center gap-2">
            <ClockIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              {formatRelativeTimeLabel(
                thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
              )}
            </div>
          </div>
          {sessionError ? (
            <div className="flex min-w-0 items-start gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word">{sessionError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}
