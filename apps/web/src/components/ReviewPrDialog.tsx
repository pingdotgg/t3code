import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  DEFAULT_RUNTIME_MODE,
  type GitFetchPrDetailsResult,
  type ProjectId,
} from "@t3tools/contracts";
import { GitPullRequestIcon, LoaderIcon } from "lucide-react";

import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";
import {
  gitCreateWorktreeMutationOptions,
  gitFetchPrDetailsMutationOptions,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
import { newThreadId } from "../lib/utils";
import { useComposerDraftStore } from "../composerDraftStore";

const GITHUB_PR_URL_REGEX = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function isLikelyPrReference(value: string): boolean {
  const trimmed = value.trim();
  if (GITHUB_PR_URL_REGEX.test(trimmed)) return true;
  // Numeric PR number (e.g. "123")
  if (/^\d+$/.test(trimmed)) return true;
  // owner/repo#number format
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(trimmed)) return true;
  return false;
}

/**
 * Normalize a PR reference by stripping URL fragments and query params.
 * e.g. "https://github.com/org/repo/pull/72#pullrequestreview-123" → "https://github.com/org/repo/pull/72"
 */
function normalizePrReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http")) return trimmed;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function buildReviewPrompt(pr: GitFetchPrDetailsResult): string {
  const lines = [
    `Review PR #${pr.number}: ${pr.title}`,
    "",
    `Base: \`${pr.baseRefName}\` <- Head: \`${pr.headRefName}\``,
    `Changes: +${pr.additions} -${pr.deletions} across ${pr.changedFiles} file${pr.changedFiles !== 1 ? "s" : ""}`,
    "",
  ];

  if (pr.body.trim().length > 0) {
    lines.push("## PR Description", "", pr.body.trim(), "");
  }

  lines.push(
    "---",
    "",
    "Please review the changes in this PR. Focus on correctness, performance, and potential issues. Summarize your findings and flag anything that needs attention.",
  );

  return lines.join("\n");
}

interface ReviewPrDialogProps {
  projectId: ProjectId;
  projectCwd: string;
  onClose: () => void;
}

export default function ReviewPrDialog({ projectId, projectCwd, onClose }: ReviewPrDialogProps) {
  const [prInput, setPrInput] = useState("");
  const [prDetails, setPrDetails] = useState<GitFetchPrDetailsResult | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);

  const fetchPrMutation = useMutation(gitFetchPrDetailsMutationOptions());
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));

  const handleFetch = useCallback(() => {
    const trimmed = prInput.trim();
    if (!trimmed) return;

    const normalized = normalizePrReference(trimmed);
    setPrDetails(null);
    fetchPrMutation.mutate(
      { cwd: projectCwd, prUrl: normalized },
      {
        onSuccess: (data) => setPrDetails(data),
        onError: (error) => {
          toastManager.add({
            type: "error",
            title: "Failed to fetch PR details",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      },
    );
  }, [fetchPrMutation, prInput, projectCwd]);

  const handleStartReview = useCallback(async () => {
    if (!prDetails) return;

    setIsCreating(true);
    try {
      // Fetch the PR branch into local refs
      const worktreeResult = await createWorktreeMutation.mutateAsync({
        cwd: projectCwd,
        branch: `origin/${prDetails.headRefName}`,
        newBranch: `review/pr-${prDetails.number}-${Date.now().toString(36)}`,
      });

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();

      // Create the draft thread with worktree context
      setProjectDraftThreadId(projectId, threadId, {
        createdAt,
        branch: prDetails.headRefName,
        worktreePath: worktreeResult.worktree.path,
        envMode: "worktree",
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });

      // Pre-fill the composer with the review prompt
      useComposerDraftStore.getState().setPrompt(threadId, buildReviewPrompt(prDetails));

      await invalidateGitQueries(queryClient);

      // Navigate to the new thread
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });

      // Close dialog and reset state
      onClose();
      setPrInput("");
      setPrDetails(null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to set up PR review",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsCreating(false);
    }
  }, [
    createWorktreeMutation,
    navigate,
    onClose,
    prDetails,
    projectCwd,
    projectId,
    queryClient,
    setProjectDraftThreadId,
  ]);

  const canFetch = prInput.trim().length > 0 && isLikelyPrReference(prInput);
  const isBusy = fetchPrMutation.isPending || isCreating;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <GitPullRequestIcon className="size-5" />
          Review Pull Request
        </DialogTitle>
        <DialogDescription>
          Enter a GitHub PR URL or number to create a review workspace.
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <div className="flex flex-col gap-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleFetch();
            }}
          >
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                placeholder="https://github.com/owner/repo/pull/123"
                value={prInput}
                onChange={(event) => {
                  setPrInput(event.target.value);
                  setPrDetails(null);
                }}
                disabled={isBusy}
                autoFocus
              />
              <Button type="submit" variant="outline" size="sm" disabled={!canFetch || isBusy}>
                {fetchPrMutation.isPending ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  "Fetch"
                )}
              </Button>
            </div>
          </form>

          {prDetails && (
            <div className="rounded-lg border bg-muted/50 p-3">
              <div className="flex items-start gap-2">
                <GitPullRequestIcon
                  className={`mt-0.5 size-4 shrink-0 ${
                    prDetails.state === "OPEN"
                      ? "text-emerald-500"
                      : prDetails.state === "MERGED"
                        ? "text-violet-500"
                        : "text-zinc-400"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    #{prDetails.number} {prDetails.title}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {prDetails.baseRefName} &larr; {prDetails.headRefName}
                    </span>
                    <span className="text-emerald-500">+{prDetails.additions}</span>
                    <span className="text-rose-500">-{prDetails.deletions}</span>
                    <span>
                      {prDetails.changedFiles} file{prDetails.changedFiles !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {prDetails.body.trim().length > 0 && (
                    <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                      {prDetails.body.trim()}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {fetchPrMutation.isError && (
            <p className="text-xs text-destructive">
              {fetchPrMutation.error instanceof Error
                ? fetchPrMutation.error.message
                : "Failed to fetch PR details."}
            </p>
          )}
        </div>
      </DialogPanel>

      <DialogFooter variant="bare">
        <Button onClick={handleStartReview} disabled={!prDetails || isBusy}>
          {isCreating ? (
            <>
              <LoaderIcon className="size-3.5 animate-spin" />
              Setting up...
            </>
          ) : (
            "Start Review"
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
