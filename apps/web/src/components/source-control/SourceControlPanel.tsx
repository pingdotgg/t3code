import type {
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "~/components/ProjectScriptsControl";

import {
  isFederatedSourceControlTargetExpanded,
  resolveFederatedSourceControlTargets,
  type FederatedSourceControlTarget,
  type SourceControlEnvironmentCandidate,
  type SourceControlPeerSyncTarget,
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
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onRunProjectScript: (
    target: SourceControlProjectActionTarget,
    script: ProjectScript,
  ) => void;
  readonly onAddProjectScript: (
    target: SourceControlProjectActionTarget,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  readonly onUpdateProjectScript: (
    target: SourceControlProjectActionTarget,
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  readonly onDeleteProjectScript: (
    target: SourceControlProjectActionTarget,
    scriptId: string,
  ) => Promise<ProjectScriptActionResult>;
  readonly onThreadRefChange?: SourceControlEnvironmentPanelProps["onThreadRefChange"];
}

export interface SourceControlProjectActionTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: NonNullable<SourceControlEnvironmentCandidate["project"]>["id"];
  readonly cwd: string;
  readonly projectCwd: string;
  readonly worktreePath: string | null;
  readonly scripts: readonly ProjectScript[];
}

function EnvironmentProjectActions({
  keybindings,
  onAddProjectScript,
  onDeleteProjectScript,
  onRunProjectScript,
  onUpdateProjectScript,
  target,
}: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onRunProjectScript: SourceControlPanelProps["onRunProjectScript"];
  readonly onAddProjectScript: SourceControlPanelProps["onAddProjectScript"];
  readonly onUpdateProjectScript: SourceControlPanelProps["onUpdateProjectScript"];
  readonly onDeleteProjectScript: SourceControlPanelProps["onDeleteProjectScript"];
  readonly target: FederatedSourceControlTarget & {
    readonly project: NonNullable<SourceControlEnvironmentCandidate["project"]>;
  };
}) {
  const fileScripts = useT3ProjectFileScripts(target.environmentId, target.project.workspaceRoot);
  const actionTarget = useMemo<SourceControlProjectActionTarget>(
    () => ({
      environmentId: target.environmentId,
      environmentLabel: target.label,
      projectId: target.project.id,
      cwd: target.cwd,
      projectCwd: target.project.workspaceRoot,
      worktreePath: target.worktreePath,
      scripts: target.project.scripts,
    }),
    [
      target.cwd,
      target.environmentId,
      target.label,
      target.project.id,
      target.project.scripts,
      target.project.workspaceRoot,
      target.worktreePath,
    ],
  );

  return (
    <ProjectScriptsControl
      scripts={target.project.scripts}
      fileScripts={fileScripts}
      keybindings={keybindings}
      preferredScriptId={target.project.preferredScriptId}
      onRunScript={(script) => onRunProjectScript(actionTarget, script)}
      onAddScript={(input) => onAddProjectScript(actionTarget, input)}
      onUpdateScript={(scriptId, input) => onUpdateProjectScript(actionTarget, scriptId, input)}
      onDeleteScript={(scriptId) => onDeleteProjectScript(actionTarget, scriptId)}
    />
  );
}

export function SourceControlPanel({
  cwd,
  environmentId,
  environments,
  keybindings,
  onAddProjectScript,
  onDeleteProjectScript,
  onRunProjectScript,
  onUpdateProjectScript,
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
  const peerSyncTargets = useMemo<readonly SourceControlPeerSyncTarget[]>(
    () => targets.map((target) => ({ environmentId: target.environmentId, cwd: target.cwd })),
    [targets],
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
        activeThreadRef={activeThreadRef}
        peerSyncTargets={peerSyncTargets}
        {...(onThreadRefChange ? { onThreadRefChange } : {})}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      {targets.map((target) => {
        const expanded = isFederatedSourceControlTargetExpanded(target, expandedEnvironmentIds);
        const panelKey = sourceControlPanelStateCacheKey({
          environmentId: target.environmentId,
          threadId,
          cwd: target.cwd,
          worktreePath: target.worktreePath,
        });
        const environmentHeaderContents = (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <EnvironmentMachineIcon
                aria-hidden
                kind={target.machine}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {target.label}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="block min-w-0 truncate pl-6.5 font-mono text-xs text-muted-foreground/70" />
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
          </div>
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
              <div className="mx-2 my-1 flex min-h-12 shrink-0 items-center rounded-md px-2.5 py-1.5">
                {environmentHeaderContents}
              </div>
            ) : (
              <button
                type="button"
                className="mx-2 my-1 flex min-h-12 w-[calc(100%-1rem)] shrink-0 cursor-pointer items-center rounded-md px-2.5 py-1.5 text-left text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                activeThreadRef={target.active ? activeThreadRef : null}
                peerSyncTargets={peerSyncTargets}
                repositoryAction={
                  targets.length > 1 && target.project ? (
                    <EnvironmentProjectActions
                      target={{ ...target, project: target.project }}
                      keybindings={keybindings}
                      onRunProjectScript={onRunProjectScript}
                      onAddProjectScript={onAddProjectScript}
                      onUpdateProjectScript={onUpdateProjectScript}
                      onDeleteProjectScript={onDeleteProjectScript}
                    />
                  ) : undefined
                }
                {...(target.active && onThreadRefChange ? { onThreadRefChange } : {})}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
