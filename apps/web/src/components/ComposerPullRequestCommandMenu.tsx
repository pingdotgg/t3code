import type { GitResolvePullRequestResult } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  gitPreparePullRequestThreadMutationOptions,
  gitResolvePullRequestQueryOptions,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface ComposerPullRequestCommandMenuProps {
  cwd: string | null;
  initialReference: string | null;
  onCancel: () => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

export function ComposerPullRequestCommandMenu({
  cwd,
  initialReference,
  onCancel,
  onPrepared,
}: ComposerPullRequestCommandMenuProps) {
  const queryClient = useQueryClient();
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );

  useEffect(() => {
    setReference(initialReference ?? "");
    setReferenceDirty(false);
    setPreparingMode(null);
  }, [initialReference]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const resolvePullRequestQuery = useQuery(
    gitResolvePullRequestQueryOptions({
      cwd,
      reference: parsedDebouncedReference,
    }),
  );
  const cachedPullRequest = useMemo(() => {
    if (!cwd || !parsedReference) {
      return null;
    }
    const cached = queryClient.getQueryData<GitResolvePullRequestResult>([
      "git",
      "pull-request",
      cwd,
      parsedReference,
    ]);
    return cached?.pullRequest ?? null;
  }, [cwd, parsedReference, queryClient]);
  const preparePullRequestThreadMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({ cwd, queryClient }),
  );

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (resolvePullRequestQuery.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      resolvePullRequestQuery.isPending ||
      resolvePullRequestQuery.isFetching);
  const statusTone = useMemo(() => {
    switch (resolvedPullRequest?.state) {
      case "merged":
        return "text-violet-600 dark:text-violet-300/90";
      case "closed":
        return "text-zinc-500 dark:text-zinc-400/80";
      case "open":
        return "text-emerald-600 dark:text-emerald-300/90";
      default:
        return "text-muted-foreground";
    }
  }, [resolvedPullRequest?.state]);

  const handleConfirm = useCallback(async (mode: "local" | "worktree") => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!parsedReference || !resolvedPullRequest || !cwd) {
      return;
    }
    setPreparingMode(mode);
    try {
      const result = await preparePullRequestThreadMutation.mutateAsync({
        reference: parsedReference,
        mode,
      });
      await onPrepared({
        branch: result.branch,
        worktreePath: result.worktreePath,
      });
    } finally {
      setPreparingMode(null);
    }
  }, [
    cwd,
    onPrepared,
    parsedReference,
    preparePullRequestThreadMutation,
    resolvedPullRequest,
  ]);

  const validationMessage =
    !referenceDirty
      ? null
      : reference.trim().length === 0
      ? "Paste a GitHub pull request URL or enter 123 / #123."
      : parsedReference === null
        ? "Use a GitHub pull request URL, 123, or #123."
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && resolvePullRequestQuery.isError
      ? (resolvePullRequestQuery.error instanceof Error
          ? resolvePullRequestQuery.error.message
          : "Failed to resolve pull request.")
      : (preparePullRequestThreadMutation.error instanceof Error
          ? preparePullRequestThreadMutation.error.message
          : preparePullRequestThreadMutation.error
            ? "Failed to prepare pull request thread."
            : null));

  return (
    <div className="overflow-hidden rounded-xl border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs">
      <div className="space-y-4 p-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-sm">Checkout Pull Request</p>
              <p className="text-muted-foreground text-xs">
                Resolve a PR, then choose Local or Worktree for the new draft thread.
              </p>
            </div>
          </div>
          <Input
            autoFocus
            ref={referenceInputRef}
            placeholder="https://github.com/owner/repo/pull/42 or #42"
            value={reference}
            onChange={(event) => {
              setReferenceDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              if (!isResolving && !preparePullRequestThreadMutation.isPending) {
                void handleConfirm("local");
              }
            }}
          />
        </div>

        {resolvedPullRequest ? (
          <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-sm">{resolvedPullRequest.title}</p>
                <p className="truncate text-muted-foreground text-xs">
                  #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} to{" "}
                  {resolvedPullRequest.baseBranch}
                </p>
              </div>
              <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                {resolvedPullRequest.state}
              </span>
            </div>
          </div>
        ) : null}

        {isResolving ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" />
            Resolving pull request...
          </div>
        ) : null}

        {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <p className="text-muted-foreground text-xs">
          {resolvedPullRequest
            ? "Create the draft thread in the main repo or in a dedicated worktree."
            : "Resolve the pull request first."}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void handleConfirm("local");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadMutation.isPending
            }
          >
            {preparingMode === "local" ? "Preparing local..." : "Local"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm("worktree");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadMutation.isPending
            }
          >
            {preparingMode === "worktree" ? "Preparing worktree..." : "Worktree"}
          </Button>
        </div>
      </div>
    </div>
  );
}
