import { memo, useId, useMemo, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationProposedPlanReview,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentThread } from "~/state/threads";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  planId,
  review = null,
  reviewStarting = false,
  sourceBusy = false,
  onReviewPlan,
  onOpenReview,
  onRevisePlan,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  planId: string;
  review?: OrchestrationProposedPlanReview | null;
  reviewStarting?: boolean;
  sourceBusy?: boolean;
  onReviewPlan?: ((planId: string) => void) | undefined;
  onOpenReview?: ((reviewThreadId: ThreadId) => void) | undefined;
  onRevisePlan?: ((input: { planId: string; feedback: string }) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy plan",
          description: error instanceof Error ? error.message : "An error occurred while copying.",
        }),
      );
    },
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);
  const reviewThreadState = useEnvironmentThread(
    review ? environmentId : null,
    review?.reviewThreadId ?? null,
  );
  const reviewThread = Option.getOrNull(reviewThreadState.data);
  const reviewFeedback = useMemo(
    () =>
      [...(reviewThread?.messages ?? [])]
        .reverse()
        .find(
          (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
        )
        ?.text.trim() ?? null,
    [reviewThread?.messages],
  );
  const reviewState = review
    ? reviewThread?.latestTurn?.state === "completed"
      ? "completed"
      : reviewThread?.latestTurn?.state === "error"
        ? "error"
        : reviewThread?.latestTurn?.state === "interrupted"
          ? "stopped"
          : "running"
    : null;
  const reviewLabel = reviewStarting
    ? "Starting review…"
    : reviewState === "completed"
      ? "Review complete"
      : reviewState === "error"
        ? "Review failed"
        : reviewState === "stopped"
          ? "Review stopped"
          : reviewState === "running"
            ? "Reviewing…"
            : null;

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Workspace path is unavailable",
          description: "This thread does not have a workspace path to save into.",
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const relativePath = savePath.trim();
    if (!workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred while saving.",
          }),
        );
      }
    })();
  };

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse || onReviewPlan ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {onReviewPlan ? (
              <>
                {reviewLabel ? (
                  <span className="self-center text-muted-foreground text-xs">{reviewLabel}</span>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  data-scroll-anchor-ignore
                  disabled={reviewStarting || reviewState === "running"}
                  onClick={() => onReviewPlan(planId)}
                >
                  {reviewState === "completed" ||
                  reviewState === "error" ||
                  reviewState === "stopped"
                    ? "Review again"
                    : reviewStarting || reviewState === "running"
                      ? reviewLabel
                      : "Review plan"}
                </Button>
                {review && onOpenReview ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-scroll-anchor-ignore
                    onClick={() => onOpenReview(review.reviewThreadId)}
                  >
                    Open review
                  </Button>
                ) : null}
                {review && reviewState === "completed" && onRevisePlan ? (
                  <Button
                    size="sm"
                    data-scroll-anchor-ignore
                    disabled={sourceBusy || reviewFeedback === null}
                    onClick={() => {
                      if (reviewFeedback !== null) {
                        onRevisePlan({ planId, feedback: reviewFeedback });
                      }
                    }}
                  >
                    Revise plan
                  </Button>
                ) : null}
              </>
            ) : null}
            {canCollapse ? (
              <Button
                size="sm"
                variant="outline"
                data-scroll-anchor-ignore
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Collapse plan" : "Expand plan"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
