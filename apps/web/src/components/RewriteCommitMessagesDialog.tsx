import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GitListRewriteableCommitsResult,
  GitRewriteableCommit,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { gitEnvironment } from "~/state/git";
import { useAtomCommand } from "~/state/use-atom-command";

const MAX_SELECTED_COMMITS = 20;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function commitDetails(commit: GitRewriteableCommit): string {
  const fileCount = commit.files.length;
  const files = commit.files.slice(0, 3).join(", ");
  const overflow = fileCount > 3 ? `, +${fileCount - 3} more` : "";
  return `${fileCount} ${fileCount === 1 ? "file" : "files"}${files ? ` · ${files}${overflow}` : ""}`;
}

export function RewriteCommitMessagesDialog({
  open,
  environmentId,
  cwd,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const canRewrite = useAtomValue(
    gitEnvironment.rewriteCommitMessages.permissionAtom(environmentId),
  );
  const listCommits = useAtomCommand(gitEnvironment.listRewriteableCommits, {
    reportFailure: false,
  });
  const rewriteMessages = useAtomCommand(gitEnvironment.rewriteCommitMessages, {
    reportFailure: false,
  });
  const [result, setResult] = useState<GitListRewriteableCommitsResult | null>(null);
  const [selectedShas, setSelectedShas] = useState<ReadonlySet<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(() => {
    if (environmentId === null || cwd === null) {
      return;
    }
    setIsLoading(true);
    setFailure(null);
    setResult(null);
    setSelectedShas(new Set());
    void listCommits({ environmentId, input: { cwd } }).then((commandResult) => {
      setIsLoading(false);
      if (commandResult._tag === "Failure") {
        setFailure(errorMessage(squashAtomCommandFailure(commandResult)));
        return;
      }
      setResult(commandResult.value);
    });
  }, [cwd, environmentId, listCommits]);

  useEffect(() => {
    if (open) {
      load();
    }
  }, [load, open]);

  const commits = result?.commits ?? [];
  const selectedCount = selectedShas.size;
  const allSelected = commits.length > 0 && selectedCount === commits.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const selectionTooLarge = selectedCount > MAX_SELECTED_COMMITS;
  const submit = useCallback(() => {
    if (
      environmentId === null ||
      cwd === null ||
      result === null ||
      selectedShas.size === 0 ||
      selectedShas.size > MAX_SELECTED_COMMITS
    ) {
      return;
    }
    setIsRewriting(true);
    setFailure(null);
    void rewriteMessages({
      environmentId,
      input: {
        cwd,
        expectedHeadSha: result.headSha,
        commitShas: commits
          .filter((commit) => selectedShas.has(commit.sha))
          .map((commit) => commit.sha),
      },
    }).then((commandResult) => {
      setIsRewriting(false);
      if (commandResult._tag === "Failure") {
        setFailure(errorMessage(squashAtomCommandFailure(commandResult)));
        return;
      }
      const count = commandResult.value.rewrittenCount;
      toastManager.add({
        type: "success",
        title: `Rewrote ${count} commit ${count === 1 ? "message" : "messages"}`,
        description: "Branch history updated; source files and working-tree changes are unchanged.",
      });
      onOpenChange(false);
    });
  }, [commits, cwd, environmentId, onOpenChange, result, rewriteMessages, selectedShas]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isRewriting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Regenerate commit messages</DialogTitle>
          <DialogDescription>
            Generate a new message from each selected commit&apos;s own diff. T3 Code recreates
            commit objects and verifies that the final tree is identical before moving the branch;
            files, the index, and working-tree changes are never modified.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              Loading local commits...
            </div>
          ) : failure && result === null ? (
            <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <p>{failure}</p>
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </div>
          ) : commits.length === 0 ? (
            <div className="rounded-md border border-input bg-muted/40 p-4 text-sm text-muted-foreground">
              No local branch commits are available to rewrite. Create a commit ahead of the branch
              base or upstream first.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-input bg-background">
              <div className="flex items-center justify-between border-b border-input bg-muted/40 px-3 py-2 text-xs">
                <label className="flex items-center gap-2 font-medium">
                  <Checkbox
                    aria-label="Select all commit messages"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={() =>
                      setSelectedShas(
                        allSelected ? new Set() : new Set(commits.map((commit) => commit.sha)),
                      )
                    }
                  />
                  Commit messages
                </label>
                <span className="text-muted-foreground">
                  {selectedCount} of {commits.length} selected
                </span>
              </div>
              <ScrollArea className="h-72">
                <div className="divide-y divide-input">
                  {commits.map((commit) => {
                    const selected = selectedShas.has(commit.sha);
                    return (
                      <label
                        key={commit.sha}
                        className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50"
                      >
                        <Checkbox
                          aria-label={`Regenerate message for ${commit.subject}`}
                          checked={selected}
                          onCheckedChange={() => {
                            const next = new Set(selectedShas);
                            if (selected) {
                              next.delete(commit.sha);
                            } else {
                              next.add(commit.sha);
                            }
                            setSelectedShas(next);
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-sm font-medium">{commit.subject}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              {commit.shortSha}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {commitDetails(commit)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}

          {selectionTooLarge ? (
            <p role="alert" className="text-xs text-destructive">
              Select at most {MAX_SELECTED_COMMITS} commit messages at once.
            </p>
          ) : null}
          {failure && result !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {failure}
            </p>
          ) : null}
          {commits.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Rewriting changes commit IDs and may require a force push. Signed commits are blocked
              because recreating them would invalidate their signatures.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={isRewriting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              !canRewrite || isLoading || isRewriting || selectedCount === 0 || selectionTooLarge
            }
            onClick={submit}
          >
            {isRewriting ? "Regenerating..." : `Regenerate ${selectedCount || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
