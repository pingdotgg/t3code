import { memo, useState, useCallback } from "react";
import type { EnvironmentId, OrchestrationThreadGoal } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readEnvironmentApi } from "~/environmentApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ThreadGoalPanel } from "./ThreadGoalPanel";
import { ThreadSidebar } from "./ThreadSidebar";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  activeGoal: OrchestrationThreadGoal | null;
  goalCommandDisabled?: boolean | null;
  onSubmitGoalCommand?: (command: "/goal pause" | "/goal resume" | "/goal clear") => void;
  label?: string;
  environmentId: EnvironmentId;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  activeGoal,
  goalCommandDisabled = false,
  onSubmitGoalCommand,
  label = "Plan",
  environmentId,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  mode = "sidebar",
  onClose,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [environmentId, planMarkdown, workspaceRoot]);

  const headerMeta = activePlan ? (
    <span className="text-[11px] text-muted-foreground/60 tabular-nums">
      {formatTimestamp(activePlan.createdAt, timestampFormat)}
    </span>
  ) : null;

  const actions = (
    <>
      {planMarkdown ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground/50 hover:text-foreground/70"
                aria-label="Plan actions"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem
              onClick={handleSaveToWorkspace}
              disabled={!workspaceRoot || isSavingToWorkspace}
            >
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );

  return (
    <ThreadSidebar
      label={label}
      mode={mode}
      headerMeta={headerMeta}
      actions={actions}
      onClose={onClose}
    >
      {activeGoal ? (
        <ThreadGoalPanel
          goal={activeGoal}
          commandDisabled={goalCommandDisabled}
          {...(onSubmitGoalCommand ? { onSubmitGoalCommand } : {})}
        />
      ) : null}

      {/* Explanation */}
      {activePlan?.explanation ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground/80">
          {activePlan.explanation}
        </p>
      ) : null}

      {/* Plan Steps */}
      {activePlan && activePlan.steps.length > 0 ? (
        <div className="space-y-1">
          <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
            Steps
          </p>
          {activePlan.steps.map((step) => (
            <div
              key={`${step.status}:${step.step}`}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                step.status === "inProgress" && "bg-blue-500/5",
                step.status === "completed" && "bg-emerald-500/5",
              )}
            >
              {stepStatusIcon(step.status)}
              <p
                className={cn(
                  "text-[13px] leading-snug",
                  step.status === "completed"
                    ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                    : step.status === "inProgress"
                      ? "text-foreground/90"
                      : "text-muted-foreground/70",
                )}
              >
                {step.step}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Proposed Plan Markdown */}
      {planMarkdown ? (
        <div className="space-y-2">
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 text-left"
            onClick={() => setProposedPlanExpanded((v) => !v)}
          >
            {proposedPlanExpanded ? (
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
            )}
            <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
              {planTitle ?? "Full Plan"}
            </span>
          </button>
          {proposedPlanExpanded ? (
            <div className="rounded-lg border border-border/50 bg-background/50 p-3">
              <ChatMarkdown
                text={displayedPlanMarkdown ?? ""}
                cwd={markdownCwd}
                isStreaming={false}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Empty state */}
      {!activeGoal && !activePlan && !planMarkdown ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
          <p className="mt-1 text-[11px] text-muted-foreground/30">
            Plans will appear here when generated.
          </p>
        </div>
      ) : null}
    </ThreadSidebar>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
