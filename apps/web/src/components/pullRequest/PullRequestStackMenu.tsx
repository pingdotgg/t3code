import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { msg, T, useGT, Var } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
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
import type { ChangeRequestTerminology } from "~/sourceControlPresentation";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import { PullRequestGlyph } from "./pullRequestIcons";
import { mergeHeadPin, readableFailure } from "./pullRequestDetail.logic";

import { changeRequestTermKind } from "./changeRequestTerm";

export function PullRequestStackMenu({
  hostLabel,
  terminology,
  stack,
  reference,
  environmentId,
  shownHeadSha,
  stale,
  canMerge,
  canRebase,
  mergeMethod,
  onSelect,
  onActed,
  notice,
  onRetry,
}: {
  hostLabel: string;
  terminology: ChangeRequestTerminology;
  notice?: string | null;
  onRetry?: (() => void) | undefined;
  stack: PullRequestStack;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  /** The head of `reference` the reader was shown; the stack read can run ahead of it. */
  shownHeadSha: string | undefined;
  stale: boolean;
  canMerge: boolean;
  canRebase: boolean;
  mergeMethod: PullRequestMergeMethod;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  onActed: () => void;
}) {
  const gt = useGT();
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
    stale ||
    selectedLayer?.state !== "open" ||
    mergeLayers.some((layer) => !layer.headSha) ||
    mergeHasClosed ||
    mergeLayers.length === 0 ||
    mergeLayers.some((layer) => layer.isDraft);
  const staleReason = notice ?? gt("Checking the stack with the host…");
  const rebaseDisabled = pending || stale || hasUnknownHead || hasClosed || unmerged.length === 0;
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
      title: action === "merge" ? m(msg("Merging stack...")) : m(msg("Rebasing stack...")),
    });
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        number: target.number,
        stackNumber: stack.number,
        expectedStackHeads: actionHeads,
        ...mergeHeadPin(action, shownHeadSha),
        action,
        ...(action === "merge" ? { mergeMethod } : { updateMethod: "rebase" }),
      },
    });
    setPending(false);
    onActed();
    if (result._tag === "Failure") {
      toastManager.update(toastId, {
        type: "error",
        title:
          action === "merge"
            ? m(msg("Could not merge the stack"))
            : m(msg("Could not rebase the stack")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          action === "merge"
            ? m(
                msg(
                  "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
                ),
              )
            : m(
                msg(
                  "The host refused the rebase. A rebase stops at the first commit that does not apply cleanly.",
                ),
              ),
        ),
      });
    } else {
      toastManager.update(toastId, {
        type: "success",
        title:
          action === "merge" ? m(msg("Stack merge request completed")) : m(msg("Stack rebased")),
        description:
          action === "merge"
            ? m(msg("{host} merged the stack or added it to its merge queue.", { host: hostLabel }))
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
                    aria-label={gt("Stack {number}, layer {position} of {size}", {
                      number: stack.number,
                      position,
                      size: stack.layers.length,
                    })}
                  />
                }
              >
                <PullRequestGlyph.stack aria-hidden className="size-3.5" /> {position}/
                {stack.layers.length}
                {onRetry ? <TriangleAlertIcon aria-hidden className="size-3 text-warning" /> : null}
              </MenuTrigger>
            }
          />
          <TooltipPopup>
            <T>
              View stack #<Var>{stack.number}</Var>, layer <Var>{position}</Var> of{" "}
              <Var>{stack.layers.length}</Var>
            </T>
            {notice ? ` · ${notice}` : null}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start">
          <MenuGroup>
            <PullRequestStackHeader number={stack.number} notice={notice} stale={!!onRetry} />
            {onRetry ? (
              <MenuItem onClick={onRetry}>
                <T>Retry stack refresh</T>
              </MenuItem>
            ) : null}
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
                  <PullRequestGlyph.merged aria-hidden />
                  <T>
                    Merge stack (<Var>{mergeLayers.length}</Var>)
                  </T>
                </MenuItem>
              ) : null}
              {canRebase ? (
                <MenuItem
                  disabled={rebaseDisabled}
                  onClick={() => setConfirmation("update-branch")}
                >
                  <RefreshCwIcon aria-hidden />
                  <T>Rebase stack</T>
                </MenuItem>
              ) : null}
              {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  <T>Every layer being merged must be open and ready for review.</T>
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
                  disabled={mergeDisabled && !stale}
                  aria-disabled={mergeDisabled || undefined}
                  aria-description={stale ? staleReason : undefined}
                  onClick={mergeDisabled ? undefined : () => setConfirmation("merge")}
                >
                  <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                  <T>Merge stack</T>
                </Button>
              </span>
            }
          />
          <TooltipPopup>
            {stale
              ? staleReason
              : gt(
                  "{count, plural, one {Merge stack through '#'{number} into {base} ({count} {term, select, mr {merge request} cr {change request} other {pull request}})} other {Merge stack through '#'{number} into {base} ({count} {term, select, mr {merge requests} cr {change requests} other {pull requests}})}}",
                  {
                    count: mergeLayers.length,
                    number: reference.number,
                    base: stack.base,
                    term: changeRequestTermKind(terminology),
                  },
                )}
          </TooltipPopup>
        </Tooltip>
      ) : null}
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
                ? gt(
                    "{count, plural, one {Merge {count} {term, select, mr {merge request} cr {change request} other {pull request}}?} other {Merge {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}?}}",
                    {
                      count: mergeLayers.length,
                      term: changeRequestTermKind(terminology),
                    },
                  )
                : gt(
                    "{count, plural, one {Rebase {count} {term, select, mr {merge request} cr {change request} other {pull request}}?} other {Rebase {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}?}}",
                    {
                      count: unmerged.length,
                      term: changeRequestTermKind(terminology),
                    },
                  )}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "merge"
                ? gt(
                    "Merge #{number} and its unmerged layers below into {base} using {method}. {host} checks their rules before merging or queueing them and rebases the remaining stack after merging.",
                    {
                      number: reference.number,
                      base: stack.base,
                      method: mergeMethod,
                      host: hostLabel,
                    },
                  )
                : gt(
                    "Rebase the remote branches from bottom to top onto {base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.",
                    { base: stack.base },
                  )}
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
              <T>Cancel</T>
            </Button>
            <Button onClick={() => void run()}>
              {confirmation === "merge" ? gt("Merge stack") : gt("Rebase stack")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
