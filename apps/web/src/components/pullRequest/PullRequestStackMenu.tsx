import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { LayersIcon } from "lucide-react";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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
import { resolvePullRequestState } from "./pullRequestPresentation";
import { cn } from "~/lib/utils";

export function PullRequestStackMenu({
  stack,
  reference,
  environmentId,
  canMerge,
  canRebase,
  mergeMethod,
  onSelect,
  onActed,
}: {
  stack: PullRequestStack;
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
  const [pending, setPending] = useState(false);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const top = stack.layers.at(-1);
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const hasClosed = unmerged.some((layer) => layer.state !== "open");
  const position = stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  const mergeDisabled =
    pending ||
    !top?.headSha ||
    hasClosed ||
    unmerged.length === 0 ||
    unmerged.some((layer) => layer.isDraft);
  const rebaseDisabled = pending || !top?.headSha || hasClosed || unmerged.length === 0;
  const run = async () => {
    if (pending || !confirmation || !top?.headSha) return;
    setPending(true);
    const action = confirmation;
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        number: top.number,
        stackNumber: stack.number,
        expectedHeadSha: top.headSha,
        action,
        ...(action === "merge" ? { mergeMethod } : { updateMethod: "rebase" }),
      },
    });
    setPending(false);
    setConfirmation(null);
    onActed();
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Stack operation did not complete",
        description: String(squashAtomCommandFailure(result)),
      });
    } else {
      toastManager.add({
        type: "success",
        title: action === "merge" ? "Stack merge request completed" : "Stack rebased",
        description:
          action === "merge"
            ? "GitHub merged the stack or added it to its merge queue."
            : undefined,
      });
    }
  };
  const layers = (
    <div className="max-h-80 overflow-y-auto">
      {stack.layers.toReversed().map((layer) => {
        const state = resolvePullRequestState({
          state: layer.state,
          isDraft: layer.isDraft ?? false,
        });
        return (
          <InlineButton
            key={layer.number}
            className={cn(
              "w-full justify-start gap-3 rounded-md p-2 text-left hover:bg-accent",
              layer.number === reference.number && "bg-accent",
            )}
            onClick={() => {
              setOpen(false);
              onSelect?.({ ...reference, number: layer.number });
            }}
            disabled={!onSelect || pending}
            aria-current={layer.number === reference.number ? "true" : undefined}
          >
            <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{layer.title || layer.headBranch}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                #{layer.number} · {layer.headBranch} · {state.label}
              </span>
            </span>
          </InlineButton>
        );
      })}
      <div className="px-3 py-2 font-mono text-xs text-muted-foreground">↳ {stack.base}</div>
    </div>
  );
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              aria-label={`Stack ${stack.number}, layer ${position} of ${stack.layers.length}`}
            />
          }
        >
          <LayersIcon aria-hidden className="size-3.5" /> {position}/{stack.layers.length}
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-96 max-w-[calc(100vw-2rem)] p-2">
          <div className="px-3 py-2 text-sm font-medium">Stack #{stack.number}</div>
          {layers}
          {canMerge || canRebase ? (
            <div className="flex flex-wrap gap-2 border-t pt-2">
              {canMerge ? (
                <Button
                  size="sm"
                  disabled={mergeDisabled}
                  onClick={() => {
                    setOpen(false);
                    setConfirmation("merge");
                  }}
                >
                  Merge stack ({unmerged.length})
                </Button>
              ) : null}
              {canRebase ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseDisabled}
                  onClick={() => {
                    setOpen(false);
                    setConfirmation("update-branch");
                  }}
                >
                  Rebase stack
                </Button>
              ) : null}
              {hasClosed || unmerged.some((layer) => layer.isDraft) ? (
                <p className="px-1 text-xs text-muted-foreground">
                  Every unmerged layer must be open and ready for review before merging.
                </p>
              ) : null}
            </div>
          ) : null}
        </PopoverPopup>
      </Popover>
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
                ? `Merge ${unmerged.length} pull requests?`
                : `Rebase ${unmerged.length} pull requests?`}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "merge"
                ? `Merge the entire stack into ${stack.base} using ${mergeMethod}. GitHub checks every layer's rules before merging or queueing the stack.`
                : `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="max-h-48 overflow-y-auto text-sm">
              {unmerged.map((layer) => (
                <div key={layer.number}>
                  #{layer.number} {layer.title || layer.headBranch}
                </div>
              ))}
            </div>
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
