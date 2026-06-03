import { memo } from "react";
import type {
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { DiffIcon, TerminalSquareIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import GitActionsControl from "../GitActionsControl";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DraftId } from "~/composerDraftStore";

interface MobileActionBarProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  activeProjectName: string | undefined;
  gitCwd: string | null;
  isGitRepo: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  onToggleTerminal: () => void;
  diffOpen: boolean;
  diffToggleShortcutLabel: string | null;
  onToggleDiff: () => void;
}

function CellDivider() {
  return <div className="w-px self-stretch shrink-0 bg-border/50" aria-hidden="true" />;
}

export const MobileActionBar = memo(function MobileActionBar({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  activeProjectName,
  gitCwd,
  isGitRepo,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  onToggleTerminal,
  diffOpen,
  diffToggleShortcutLabel,
  onToggleDiff,
}: MobileActionBarProps) {
  const hasScripts = Boolean(activeProjectScripts);
  const hasProject = Boolean(activeProjectName);

  const cells: Array<{ key: string; node: React.ReactNode }> = [];

  if (hasScripts && activeProjectScripts) {
    cells.push({
      key: "scripts",
      node: (
        <ProjectScriptsControl
          scripts={activeProjectScripts}
          keybindings={keybindings}
          preferredScriptId={preferredScriptId}
          onRunScript={onRunProjectScript}
          onAddScript={onAddProjectScript}
          onUpdateScript={onUpdateProjectScript}
          onDeleteScript={onDeleteProjectScript}
          surface="segmented"
        />
      ),
    });
  }

  if (hasProject) {
    cells.push({
      key: "git",
      node: (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
          {...(draftId ? { draftId } : {})}
          surface="segmented"
        />
      ),
    });
  }

  if (terminalAvailable || terminalOpen) {
    cells.push({
      key: "terminal",
      node: (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                variant="default"
                size="xs"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                disabled={!terminalAvailable}
                className={cn(
                  "flex-1 h-full rounded-none",
                  terminalOpen &&
                    "bg-primary/10 text-primary data-pressed:bg-primary/10 data-pressed:text-primary",
                )}
              >
                <TerminalSquareIcon className="size-4" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {terminalToggleShortcutLabel
              ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
              : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
      ),
    });
  }

  if (isGitRepo || diffOpen) {
    cells.push({
      key: "diff",
      node: (
        <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  variant="default"
                  size="xs"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle diff panel"
                  className={cn(
                    "flex-1 h-full rounded-none",
                    diffOpen &&
                      "bg-primary/10 text-primary data-pressed:bg-primary/10 data-pressed:text-primary",
                  )}
                >
                  <DiffIcon className="size-4" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
            </TooltipPopup>
          </Tooltip>
      ),
    });
  }

  return (
    <div
      className="@container/header-actions flex h-10 items-stretch w-full rounded-lg border border-border/60 bg-card overflow-hidden shadow-xs"
      data-swipe-ignore="true"
    >
      {cells.map((cell, index) => (
        <span key={cell.key} className="contents">
          {index > 0 && <CellDivider />}
          <div
            data-mobile-action-cell
            className="flex flex-1 min-w-0"
            style={{ "--cell-delay": `${index * 40}ms` } as React.CSSProperties}
          >
            {cell.node}
          </div>
        </span>
      ))}
    </div>
  );
});
