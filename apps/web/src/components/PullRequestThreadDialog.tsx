import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "../i18n/messages";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useRef, useState } from "react";
import { useGT } from "gt-react";
import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";

import {
  readCachedPullRequestResolution,
  usePreparePullRequestThreadAction,
  usePullRequestResolutionState,
} from "~/state/sourceControlActions";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "@t3tools/client-runtime/pull-request-link-input";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { vcsEnvironment } from "~/state/vcs";
import { offHeadPullRequestCheckoutToast } from "./pullRequest/pullRequestCheckoutToast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

interface PullRequestThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
    pullRequestUrl: string;
  }) => Promise<void> | void;
}

function pullRequestStatusTone(state: string | undefined): string {
  switch (state) {
    case "merged":
      return "text-merged-foreground";
    case "closed":
      return "text-dim-foreground";
    case "open":
      return "text-success-foreground";
    default:
      return "text-muted-foreground";
  }
}

export function PullRequestThreadDialog({
  open,
  environmentId,
  threadId,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  const gt = useGT();
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [checkoutError, setCheckoutError] = useState<{ target: string; message: string } | null>(
    null,
  );
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const { data: gitStatus } = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
  const sourceControlPresentation = getSourceControlPresentation(gitStatus?.sourceControlProvider);
  const terminology = sourceControlPresentation.terminology;
  const term = changeRequestTermKind(terminology);
  const SourceControlIcon = sourceControlPresentation.Icon;

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const pullRequestResolution = usePullRequestResolutionState({
    environmentId,
    cwd,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedPullRequest =
    readCachedPullRequestResolution({
      environmentId,
      cwd,
      reference: parsedReference,
    })?.pullRequest ?? null;
  const preparePullRequestThreadAction = usePreparePullRequestThreadAction({ environmentId, cwd });
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (pullRequestResolution.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const checkoutTarget = JSON.stringify([environmentId, cwd, threadId, parsedReference]);
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      pullRequestResolution.isPending ||
      pullRequestResolution.isFetching);
  const statusTone = pullRequestStatusTone(resolvedPullRequest?.state);

  const handleConfirm = async (mode: "local" | "worktree") => {
    if (!preparePullRequestThreadAction.isAllowed) return;
    if (
      mode === "worktree" &&
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!parsedReference || !resolvedPullRequest || !cwd) {
      return;
    }
    setCheckoutError(null);
    setPreparingMode(mode);
    const result = await preparePullRequestThreadAction.run({
      reference: parsedReference,
      mode,
      ...(mode === "worktree" ? { threadId } : {}),
    });
    setPreparingMode(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setCheckoutError({
          target: checkoutTarget,
          message:
            thrownErrorMessage(error, m) ??
            gt(
              "Failed to prepare {term, select, mr {merge request} cr {change request} other {pull request}} thread.",
              { term },
            ),
        });
      }
      return;
    }
    await onPrepared({
      branch: result.value.branch,
      worktreePath: result.value.worktreePath,
      pullRequestUrl: result.value.pullRequest.url,
    });
    if (!result.value.isOnPullRequestHead) {
      toastManager.add(offHeadPullRequestCheckoutToast(terminology));
    }
    onOpenChange(false);
  };

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? gt(
          "Paste a {term, select, mr {merge request} cr {change request} other {pull request}} URL, checkout command, or enter 123 / #123.",
          { term },
        )
      : parsedReference === null
        ? gt(
            "Use a {term, select, mr {merge request} cr {change request} other {pull request}} URL, checkout command, 123, or #123.",
            { term },
          )
        : null;
  const errorMessage =
    validationMessage ??
    (checkoutError?.target === checkoutTarget ? checkoutError.message : null) ??
    (resolvedPullRequest === null ? pullRequestResolution.error : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!preparePullRequestThreadAction.isPending) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup
        className="max-w-xl"
        initialFocus={() => {
          referenceInputRef.current?.focus();
          referenceInputRef.current?.select();
          return false;
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <SourceControlIcon className="me-2 size-4" />
            {gt(
              "Checkout {term, select, mr {merge request} cr {change request} other {pull request}}",
              { term },
            )}
          </DialogTitle>
          <DialogDescription>
            {gt(
              "Resolve a {provider} {term, select, mr {merge request} cr {change request} other {pull request}}, then create the draft thread in the main repo or in a dedicated worktree.",
              { provider: sourceControlPresentation.providerName, term },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground capitalize">
              {gt("{term, select, mr {merge request} cr {change request} other {pull request}}", {
                term,
                $context: "field label, capitalized by CSS",
              })}
            </span>
            <Input
              ref={referenceInputRef}
              placeholder={gt(
                "{term, select, mr {MR} cr {change request} other {PR}} URL, checkout command, or #42",
                {
                  term,
                },
              )}
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !preparePullRequestThreadAction.isPending) {
                  void handleConfirm("worktree");
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-card surface-panel p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm text-strong-foreground">
                    {resolvedPullRequest.title}
                  </p>
                  <div className="text-muted-foreground text-meta">
                    <p>#{resolvedPullRequest.number}</p>
                    <p className="truncate">
                      {resolvedPullRequest.headBranch} to {resolvedPullRequest.baseBranch}
                    </p>
                  </div>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {gt(
                    "{state, select, open {open} closed {closed} merged {merged} other {{state}}}",
                    {
                      state: resolvedPullRequest.state,
                      $context: "pull request state, capitalized by CSS",
                    },
                  )}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner size="sm" />
              {gt(
                "Resolving {term, select, mr {merge request} cr {change request} other {pull request}}...",
                { term },
              )}
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={preparePullRequestThreadAction.isPending}
          >
            {gt("Cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => handleConfirm("local")}
            disabled={
              !preparePullRequestThreadAction.isAllowed ||
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending
            }
          >
            {preparingMode === "local"
              ? gt("Preparing local...")
              : gt("Local", { $context: "checkout in the main repo" })}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => handleConfirm("worktree")}
            disabled={
              !preparePullRequestThreadAction.isAllowed ||
              !canOperateThread ||
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending
            }
          >
            {preparingMode === "worktree"
              ? gt("Preparing worktree...")
              : gt("Worktree", { $context: "checkout in a new git worktree" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
