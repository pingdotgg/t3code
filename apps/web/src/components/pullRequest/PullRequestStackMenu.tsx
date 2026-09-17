import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
  PullRequestActionInput,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { GitMergeIcon, LayersIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger, MenuItem, MenuGroup, MenuSeparator } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import {
  decodePullRequestActionOutcome,
  inspectionInput,
  pullRequestActionScopeKey,
  readStoredPullRequestAction,
  type StoredPullRequestAction,
  writeStoredPullRequestAction,
} from "./pullRequestActionState";

export function PullRequestStackMenu({
  stack,
  nativeGitCafeActions,
  reference,
  environmentId,
  canMerge,
  canRebase,
  mergeMethod,
  onSelect,
  onActed,
  notice,
  onRetry,
}: {
  notice?: string | null;
  onRetry?: (() => void) | undefined;
  stack: PullRequestStack;
  nativeGitCafeActions: boolean;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  canMerge: boolean;
  canRebase: boolean;
  mergeMethod: PullRequestMergeMethod;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  onActed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"merge" | "update-branch" | null>(null);
  const storageScope = {
    ...reference,
    number: stack.layers.find((layer) => layer.state !== "merged")?.number ?? reference.number,
    stackNumber: stack.number,
    action: "merge" as const,
  };
  const scopeKey = pullRequestActionScopeKey(environmentId, storageScope);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const [storedAction, setStoredAction] = useState<StoredPullRequestAction | null>(() =>
    nativeGitCafeActions
      ? readStoredPullRequestAction(
          typeof window === "undefined" ? undefined : window.sessionStorage,
          environmentId,
          storageScope,
        )
      : null,
  );
  useEffect(() => {
    setStoredAction(
      nativeGitCafeActions
        ? readStoredPullRequestAction(
            typeof window === "undefined" ? undefined : window.sessionStorage,
            environmentId,
            storageScope,
          )
        : null,
    );
  }, [environmentId, nativeGitCafeActions, scopeKey]);
  const remember = (
    next: StoredPullRequestAction | null,
    scope: PullRequestActionInput = storageScope,
  ) => {
    writeStoredPullRequestAction(
      typeof window === "undefined" ? undefined : window.sessionStorage,
      environmentId,
      next,
      scope,
    );
    if (currentScopeKey.current === pullRequestActionScopeKey(environmentId, scope)) {
      setStoredAction(next);
    }
  };
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setPending(false);
    setConfirmation(null);
  }, [scopeKey]);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const top = stack.layers.at(-1);
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const hasClosed = unmerged.some((layer) => layer.state !== "open");
  const position = stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  const mergeLayers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const selectedLayer = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  const expectedStackHeads = unmerged.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const hasUnknownHead = expectedStackHeads.length !== unmerged.length;
  const durablePending = storedAction?.state === "pending" || storedAction?.state === "unknown";
  const mergeDisabled =
    pending ||
    durablePending ||
    (nativeGitCafeActions && stack.revision === undefined) ||
    selectedLayer?.state !== "open" ||
    (!nativeGitCafeActions && mergeLayers.some((layer) => !layer.headSha)) ||
    mergeHasClosed ||
    mergeLayers.length === 0 ||
    mergeLayers.some((layer) => layer.isDraft);
  const rebaseDisabled =
    pending ||
    durablePending ||
    (nativeGitCafeActions && stack.revision === undefined) ||
    (!nativeGitCafeActions && hasUnknownHead) ||
    hasClosed ||
    unmerged.length === 0;
  const run = async () => {
    if (
      pending ||
      !confirmation ||
      (confirmation === "merge" ? !canMerge || mergeDisabled : !canRebase || rebaseDisabled)
    )
      return;
    const action = confirmation;
    const target = action === "merge" ? selectedLayer : nativeGitCafeActions ? unmerged[0] : top;
    if (!target || (!nativeGitCafeActions && !target.headSha)) return;
    const actionHeads = (action === "merge" ? mergeLayers : unmerged).flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    );
    const input: PullRequestActionInput = {
      ...reference,
      number: target.number,
      stackNumber: stack.number,
      ...(nativeGitCafeActions
        ? { expectedStackRevision: stack.revision, requestId: randomUUID() }
        : { expectedStackHeads: actionHeads }),
      action,
      ...(action === "merge" ? { mergeMethod } : { updateMethod: "rebase" as const }),
    };
    if (nativeGitCafeActions) {
      remember({
        input,
        state: "unknown",
        detail: "The stack request was sent, but its result has not been confirmed yet.",
      });
    }
    setPending(true);
    const result = await runAction({
      environmentId,
      input,
    });
    const isCurrentScope =
      currentScopeKey.current === pullRequestActionScopeKey(environmentId, input);
    if (isCurrentScope) setPending(false);
    if (isCurrentScope) setConfirmation(null);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      if (nativeGitCafeActions) {
        remember(
          typeof failure === "object" &&
            failure !== null &&
            "notDispatched" in failure &&
            failure.notDispatched === true
            ? null
            : {
                input,
                state: "unknown",
                detail:
                  "The stack result could not be confirmed. Do not submit it again automatically.",
              },
          input,
        );
      }
      toastManager.add({
        type: "error",
        title: "Stack operation did not complete",
        description: String(failure),
      });
    } else {
      let outcome = null;
      if (nativeGitCafeActions) {
        outcome = decodePullRequestActionOutcome(result.value);
        if (!outcome)
          remember(
            {
              input,
              state: "unknown",
              detail: "GitCafe returned an unknown stack result.",
            },
            input,
          );
        else if (outcome.state === "completed") remember(null, input);
        else if (outcome.state === "pending")
          remember({ input, ...outcome, state: "pending" }, input);
        else remember({ input, ...outcome, state: "failed" }, input);
      }
      if (isCurrentScope) onActed();
      if (nativeGitCafeActions && !outcome) return;
      toastManager.add(
        outcome?.state === "failed"
          ? { type: "error", title: "Stack operation failed", description: outcome.detail }
          : {
              type: "success",
              title: nativeGitCafeActions
                ? outcome?.state === "completed"
                  ? "Stack operation completed"
                  : "Stack operation accepted"
                : action === "merge"
                  ? "Stack merge request completed"
                  : "Stack rebased",
              description:
                action === "merge" && !nativeGitCafeActions
                  ? "GitHub merged the stack or added it to its merge queue."
                  : undefined,
            },
      );
    }
  };
  const checkStatus = async () => {
    if (!storedAction || pending) return;
    const discovery =
      storedAction.input.action === "merge"
        ? { kind: "stack-land" as const, id: "latest" }
        : { kind: "stack-restack" as const, id: "latest" };
    const discovering = !storedAction.operation;
    const input = inspectionInput(storedAction, discovery);
    if (!input) return;
    setPending(true);
    const result = await runAction({ environmentId, input });
    const isCurrentScope =
      currentScopeKey.current === pullRequestActionScopeKey(environmentId, input);
    if (isCurrentScope) setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not check stack status",
        description: String(squashAtomCommandFailure(result)),
      });
      return;
    }
    const outcome = decodePullRequestActionOutcome(result.value);
    if (!outcome) {
      toastManager.add({
        type: "error",
        title: "Stack status could not be read",
        description: "GitCafe returned an unknown stack result.",
      });
      return;
    }
    if (discovering) {
      // Latest is useful discovery, but does not identify the lost request's operation.
      remember(
        {
          input: storedAction.input,
          state: "unknown",
          detail: `Latest stack status: ${outcome.detail}`,
        },
        storedAction.input,
      );
    } else if (outcome.state === "completed") remember(null, storedAction.input);
    else {
      remember(
        {
          input: storedAction.input,
          operation: storedAction.operation,
          state: outcome.state,
          detail: outcome.detail,
        },
        storedAction.input,
      );
    }
    if (isCurrentScope && outcome.state === "completed") onActed();
  };
  const confirmationLayers = confirmation === "merge" ? mergeLayers : unmerged;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Stack ${stack.number}, layer ${position} of ${stack.layers.length}`}
                  />
                }
              >
                <LayersIcon aria-hidden className="size-3.5" /> {position}/{stack.layers.length}
                {onRetry ? <TriangleAlertIcon aria-hidden className="size-3 text-warning" /> : null}
              </MenuTrigger>
            }
          />
          <TooltipPopup>
            View stack #{stack.number}, layer {position} of {stack.layers.length}
            {notice ? ` · ${notice}` : null}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
          <MenuGroup>
            <PullRequestStackHeader number={stack.number} notice={notice} stale={!!onRetry} />
            {onRetry ? <MenuItem onClick={onRetry}>Retry stack refresh</MenuItem> : null}
            <PullRequestStackLayers
              stack={stack}
              reference={reference}
              pending={pending}
              onSelect={
                onSelect
                  ? (target) => {
                      setOpen(false);
                      onSelect(target);
                    }
                  : undefined
              }
            />
            {nativeGitCafeActions && storedAction ? (
              <div
                className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground"
                role="status"
              >
                <span>{storedAction.detail}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void checkStatus()}
                >
                  {pending ? "Checking…" : "Check status"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  render={<a href={stack.url} target="_blank" rel="noreferrer" />}
                >
                  Open on GitCafe
                </Button>
              </div>
            ) : null}
          </MenuGroup>
          {canMerge || canRebase ? (
            <>
              <MenuSeparator />
              {canMerge ? (
                <MenuItem disabled={mergeDisabled} onClick={() => setConfirmation("merge")}>
                  <GitMergeIcon aria-hidden />
                  Merge stack ({mergeLayers.length})
                </MenuItem>
              ) : null}
              {canRebase ? (
                <MenuItem
                  disabled={rebaseDisabled}
                  onClick={() => setConfirmation("update-branch")}
                >
                  <RefreshCwIcon aria-hidden />
                  Rebase stack
                </MenuItem>
              ) : null}
              {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  Every layer being merged must be open and ready for review.
                </p>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {canMerge && selectedLayer?.state === "open" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  variant="default"
                  size="xs"
                  disabled={mergeDisabled}
                  onClick={() => setConfirmation("merge")}
                >
                  <GitMergeIcon aria-hidden className="size-3.5" />
                  Merge stack
                </Button>
              </span>
            }
          />
          <TooltipPopup>
            Merge stack through #{reference.number} into {stack.base} ({mergeLayers.length}{" "}
            {mergeLayers.length === 1 ? "pull request" : "pull requests"})
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(value) => {
          if (!value && !pending) setConfirmation(null);
        }}
      >
        <DialogPopup className="max-w-md" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>
              {confirmation === "merge"
                ? `Merge ${mergeLayers.length} pull requests?`
                : `Rebase ${unmerged.length} pull requests?`}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "merge"
                ? nativeGitCafeActions
                  ? `Land the selected prefix through #${reference.number} into ${stack.base} using ${mergeMethod}. GitCafe checks the current stack revision and restacks the remaining pull requests.`
                  : `Merge #${reference.number} and its unmerged layers below into ${stack.base} using ${mergeMethod}. GitHub checks their rules before merging or queueing them and rebases the remaining stack after merging.`
                : nativeGitCafeActions
                  ? `Restack every unmerged pull request from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks.`
                  : `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {confirmationLayers.map((layer) => (
                <li
                  key={layer.number}
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
                >
                  <PullRequestStackLayerContent layer={layer} compact />
                </li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void run()}>
              {pending ? "Working…" : confirmation === "merge" ? "Merge stack" : "Rebase stack"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
