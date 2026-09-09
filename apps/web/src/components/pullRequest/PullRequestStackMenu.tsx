import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { GitMergeIcon, LayersIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuTrigger,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
} from "../ui/menu";
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
  const mergeLayers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const selectedLayer = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  const expectedStackHeads = unmerged.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const hasUnknownHead = expectedStackHeads.length !== unmerged.length;
  const mergeDisabled =
    pending ||
    selectedLayer?.state !== "open" ||
    mergeLayers.some((layer) => !layer.headSha) ||
    mergeHasClosed ||
    mergeLayers.length === 0 ||
    mergeLayers.some((layer) => layer.isDraft);
  const rebaseDisabled = pending || hasUnknownHead || hasClosed || unmerged.length === 0;
  const run = async () => {
    if (pending || !confirmation || (confirmation === "merge" ? mergeDisabled : rebaseDisabled))
      return;
    const action = confirmation;
    const target = action === "merge" ? selectedLayer : top;
    if (!target?.headSha) return;
    const actionHeads = (action === "merge" ? mergeLayers : unmerged).flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    );
    setPending(true);
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        number: target.number,
        stackNumber: stack.number,
        expectedStackHeads: actionHeads,
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
              </MenuTrigger>
            }
          />
          <TooltipPopup>
            View stack #{stack.number}, layer {position} of {stack.layers.length}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
          <MenuGroup>
            <MenuGroupLabel>Stack #{stack.number}</MenuGroupLabel>
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
                  variant="ghost"
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
                ? `Merge #${reference.number} and its unmerged layers below into ${stack.base} using ${mergeMethod}. GitHub checks their rules before merging or queueing them and rebases the remaining stack after merging.`
                : `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="max-h-48 overflow-y-auto text-sm">
              {confirmationLayers.map((layer) => (
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
