import type {
  EnvironmentId,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestStack,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";

/** Merges `reference` and every unmerged layer below it, or rebases the whole stack. */
export function usePullRequestStackAction({
  hostLabel,
  stack,
  reference,
  environmentId,
  canMerge,
  canRebase,
  mergeMethod,
  onActed,
}: {
  hostLabel: string;
  stack: PullRequestStack;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  canMerge: boolean;
  canRebase: boolean;
  mergeMethod: PullRequestMergeMethod;
  onActed: () => void;
}) {
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
    if (
      pending ||
      !confirmation ||
      (confirmation === "merge" ? !canMerge || mergeDisabled : !canRebase || rebaseDisabled)
    )
      return;
    const action = confirmation;
    const target = action === "merge" ? selectedLayer : top;
    if (!target?.headSha) return;
    const actionHeads = (action === "merge" ? mergeLayers : unmerged).flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    );
    setPending(true);
    setConfirmation(null);
    const toastId = toastManager.add({
      type: "loading",
      title: action === "merge" ? "Merging stack..." : "Rebasing stack...",
    });
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
    onActed();
    if (result._tag === "Failure") {
      toastManager.update(toastId, {
        type: "error",
        title: action === "merge" ? "Could not merge the stack" : "Could not rebase the stack",
        description: String(squashAtomCommandFailure(result)),
      });
    } else {
      toastManager.update(toastId, {
        type: "success",
        title: action === "merge" ? "Stack merge request completed" : "Stack rebased",
        description:
          action === "merge"
            ? `${hostLabel} merged the stack or added it to its merge queue.`
            : undefined,
      });
    }
  };
  const confirmationLayers = confirmation === "merge" ? mergeLayers : unmerged;
  const dialog = (
    <Dialog
      open={confirmation !== null}
      onOpenChange={(value) => {
        if (!value) setConfirmation(null);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {confirmation === "merge"
              ? `Merge ${mergeLayers.length} pull requests?`
              : `Rebase ${unmerged.length} pull requests?`}
          </DialogTitle>
          <DialogDescription>
            {confirmation === "merge"
              ? `Merge #${reference.number} and its unmerged layers below into ${stack.base} using ${mergeMethod}. ${hostLabel} checks their rules before merging or queueing them and rebases the remaining stack after merging.`
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
          <Button variant="outline" onClick={() => setConfirmation(null)}>
            Cancel
          </Button>
          <Button onClick={() => void run()}>
            {confirmation === "merge" ? "Merge stack" : "Rebase stack"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
  return {
    position,
    selectedLayer,
    mergeLayers,
    mergeHasClosed,
    mergeDisabled,
    rebaseDisabled,
    pending,
    request: setConfirmation,
    dialog,
  };
}
