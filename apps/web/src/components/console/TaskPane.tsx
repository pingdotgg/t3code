import type { TimestampFormat } from "@workbench/contracts/settings";
import { ChevronDownIcon, ChevronRightIcon, Rows3Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import type { ActivePlanState, LatestProposedPlanState, WorkLogEntry } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";

function compactWorkHeading(workEntry: WorkLogEntry): string {
  if (workEntry.requestKind === "command") return "Approval needed";
  if (workEntry.requestKind === "file-read") return "Workspace access";
  if (workEntry.requestKind === "file-change") return "Edit approval";
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "Updated files";
  }
  if (workEntry.itemType === "web_search") return "Collected sources";
  if (workEntry.itemType === "image_view") return "Reviewed image";
  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "Worked in workspace";
  }
  return workEntry.toolTitle?.trim() || workEntry.label;
}

function compactWorkPreview(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const firstChangedFile = workEntry.changedFiles?.[0];
  if (firstChangedFile) {
    const displayPath = formatWorkspaceRelativePath(firstChangedFile, workspaceRoot);
    return workEntry.changedFiles!.length > 1
      ? `${displayPath} +${workEntry.changedFiles!.length - 1}`
      : displayPath;
  }
  if (workEntry.detail?.trim()) {
    return workEntry.detail.trim();
  }
  if (workEntry.command?.trim()) {
    return workEntry.command.trim();
  }
  return null;
}

interface TaskPaneProps {
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  workEntries: ReadonlyArray<WorkLogEntry>;
  isSavingPlanToWorkspace: boolean;
  isPlanCopied: boolean;
  onCopyPlan: (markdown: string) => void;
  onSavePlanToWorkspace: () => void;
  onOpenWorkspaceFileLink: (path: string) => boolean;
}

/**
 * Body content of the Task card. The card chrome (icon + title + collapse +
 * close X) is provided by the surrounding `PaneCard` in `ConsoleRail`.
 */
export function TaskPane({
  workspaceRoot,
  markdownCwd,
  timestampFormat,
  activePlan,
  activeProposedPlan,
  workEntries,
  isSavingPlanToWorkspace,
  isPlanCopied,
  onCopyPlan,
  onSavePlanToWorkspace,
  onOpenWorkspaceFileLink,
}: TaskPaneProps) {
  const [showPlanDetails, setShowPlanDetails] = useState(false);

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  const hasContent = !!activePlan || !!activeProposedPlan || workEntries.length > 0;

  return (
    <ScrollArea className="min-h-0 max-h-[40vh]">
      <div className="space-y-3 p-3">
        {!hasContent ? (
          <div className="rounded-2xl border border-dashed border-border/60 bg-background/45 p-4 text-sm leading-6 text-muted-foreground/72">
            No active task. When the agent proposes a plan or starts work, you'll see live status
            and the task outline here.
          </div>
        ) : null}

        {hasContent ? (
          <div className="rounded-2xl border border-border/55 bg-background/55 p-4">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground/55 uppercase">
              Current task
            </p>
            <p className="mt-2 text-sm text-muted-foreground/78">
              Plan mode stays visible here while work is running.
            </p>
          </div>
        ) : null}

        {activePlan?.explanation ? (
          <div className="rounded-2xl border border-border/55 bg-background/60 p-4 text-sm leading-6 text-muted-foreground/82">
            {activePlan.explanation}
          </div>
        ) : null}

        {activePlan?.steps.length ? (
          <div className="space-y-2 rounded-2xl border border-border/55 bg-background/60 p-4">
            {activePlan.steps.map((step) => (
              <div key={`${step.status}:${step.step}`} className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    step.status === "completed" && "bg-emerald-400",
                    step.status === "inProgress" && "bg-blue-400",
                    step.status === "pending" && "bg-muted-foreground/35",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-6 text-foreground/86">{step.step}</p>
                  <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {step.status === "inProgress"
                      ? "In progress"
                      : step.status === "completed"
                        ? "Completed"
                        : "Pending"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {displayedPlanMarkdown && planMarkdown ? (
          <div className="rounded-2xl border border-border/55 bg-background/60">
            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground/88">
                  {planTitle ?? "Task outline"}
                </p>
                <p className="text-[11px] text-muted-foreground/65">
                  {formatTimestamp(activeProposedPlan!.updatedAt, timestampFormat)}
                </p>
              </div>
              <Menu>
                <MenuTrigger
                  render={<Button size="icon-xs" variant="ghost" aria-label="Task actions" />}
                >
                  <Rows3Icon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => onCopyPlan(planMarkdown)}>
                    {isPlanCopied ? "Copied!" : "Copy plan"}
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      downloadPlanAsTextFile(
                        buildProposedPlanMarkdownFilename(planMarkdown),
                        normalizePlanMarkdownForExport(planMarkdown),
                      )
                    }
                  >
                    Download markdown
                  </MenuItem>
                  <MenuItem
                    onClick={onSavePlanToWorkspace}
                    disabled={!workspaceRoot || isSavingPlanToWorkspace}
                  >
                    Save to workspace
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              onClick={() => setShowPlanDetails((value) => !value)}
            >
              <span className="text-sm text-muted-foreground/78">
                Review the current task outline
              </span>
              {showPlanDetails ? (
                <ChevronDownIcon className="size-4 text-muted-foreground/65" />
              ) : (
                <ChevronRightIcon className="size-4 text-muted-foreground/65" />
              )}
            </button>
            {showPlanDetails ? (
              <div className="border-t border-border/55 px-4 py-4">
                <ChatMarkdown
                  cwd={markdownCwd}
                  text={displayedPlanMarkdown}
                  onOpenWorkspaceFile={onOpenWorkspaceFileLink}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {workEntries.length > 0 ? (
          <div className="space-y-2">
            {workEntries
              .slice(-6)
              .toReversed()
              .map((entry) => {
                const preview = compactWorkPreview(entry, workspaceRoot);
                return (
                  <div
                    key={entry.id}
                    className="rounded-2xl border border-border/55 bg-background/55 px-4 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <Rows3Icon className="size-3.5 shrink-0 text-muted-foreground/55" />
                      <p className="min-w-0 flex-1 truncate text-sm text-foreground/86">
                        {compactWorkHeading(entry)}
                      </p>
                      <span className="text-[11px] text-muted-foreground/60">
                        {formatTimestamp(entry.createdAt, timestampFormat)}
                      </span>
                    </div>
                    {preview ? (
                      <p className="mt-1 pl-5 text-xs leading-5 text-muted-foreground/72">
                        {preview}
                      </p>
                    ) : null}
                  </div>
                );
              })}
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}
