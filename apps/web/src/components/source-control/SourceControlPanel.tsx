import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MonitorIcon, ServerIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import {
  isFederatedSourceControlTargetExpanded,
  resolveFederatedSourceControlTargets,
  type SourceControlEnvironmentCandidate,
} from "./SourceControlPanel.logic";
import {
  SourceControlEnvironmentPanel,
  type SourceControlEnvironmentPanelProps,
} from "./SourceControlEnvironmentPanel";
import { sourceControlPanelStateCacheKey } from "./SourceControlPanelCache";

interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly environments: readonly SourceControlEnvironmentCandidate[];
  readonly onThreadRefChange?: SourceControlEnvironmentPanelProps["onThreadRefChange"];
}

export function SourceControlPanel({
  cwd,
  environmentId,
  environments,
  onThreadRefChange,
  threadId,
  worktreePath,
}: SourceControlPanelProps) {
  const [expandedEnvironmentIds, setExpandedEnvironmentIds] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const targets = useMemo(
    () =>
      resolveFederatedSourceControlTargets({
        activeEnvironmentId: environmentId,
        activeCwd: cwd,
        activeWorktreePath: worktreePath,
        candidates: environments,
      }),
    [cwd, environmentId, environments, worktreePath],
  );
  const activeThreadRef = useMemo<ScopedThreadRef>(
    () => ({ environmentId, threadId }),
    [environmentId, threadId],
  );

  if (targets.length === 0) return null;

  const showEnvironmentHeaders = targets.length > 1 || targets.some((target) => !target.isPrimary);
  if (!showEnvironmentHeaders) {
    const target = targets[0]!;
    const panelKey = sourceControlPanelStateCacheKey({
      environmentId: target.environmentId,
      threadId,
      cwd: target.cwd,
      worktreePath: target.worktreePath,
    });
    return (
      <SourceControlEnvironmentPanel
        key={panelKey}
        environmentId={target.environmentId}
        threadId={threadId}
        cwd={target.cwd}
        worktreePath={target.worktreePath}
        filePanelThreadRef={activeThreadRef}
        {...(onThreadRefChange ? { onThreadRefChange } : {})}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      {targets.map((target) => {
        const EnvironmentIcon = target.isPrimary ? MonitorIcon : ServerIcon;
        const expanded = isFederatedSourceControlTargetExpanded(target, expandedEnvironmentIds);
        const panelKey = sourceControlPanelStateCacheKey({
          environmentId: target.environmentId,
          threadId,
          cwd: target.cwd,
          worktreePath: target.worktreePath,
        });
        const environmentHeaderContents = (
          <>
            <EnvironmentIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {target.label}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground/70" />
                }
              >
                {target.cwd}
              </TooltipTrigger>
              <TooltipPopup
                align="end"
                side="bottom"
                className="max-w-80 break-all font-mono text-left"
              >
                {target.cwd}
              </TooltipPopup>
            </Tooltip>
          </>
        );
        return (
          <section
            key={`${target.environmentId}:${target.cwd}`}
            data-source-control-environment={target.environmentId}
            data-expanded={expanded}
            className={cn(
              "flex min-h-0 flex-col overflow-hidden border-b border-border/70 last:border-b-0",
              expanded ? "min-h-[32rem] flex-1" : "flex-none",
            )}
          >
            {target.active ? (
              <div className="surface-subheader min-h-8 shrink-0 gap-2 border-b border-border/70 px-3">
                {environmentHeaderContents}
              </div>
            ) : (
              <button
                type="button"
                className="surface-subheader min-h-8 w-full shrink-0 gap-2 border-b border-border/70 px-3 text-left hover:bg-muted/40"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${target.label} version control`}
                onClick={() =>
                  setExpandedEnvironmentIds((current) => {
                    const next = new Set(current);
                    if (next.has(target.environmentId)) {
                      next.delete(target.environmentId);
                    } else {
                      next.add(target.environmentId);
                    }
                    return next;
                  })
                }
              >
                {environmentHeaderContents}
              </button>
            )}
            {expanded ? (
              <SourceControlEnvironmentPanel
                key={panelKey}
                environmentId={target.environmentId}
                threadId={threadId}
                cwd={target.cwd}
                worktreePath={target.worktreePath}
                filePanelThreadRef={target.active ? activeThreadRef : null}
                {...(target.active && onThreadRefChange ? { onThreadRefChange } : {})}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
