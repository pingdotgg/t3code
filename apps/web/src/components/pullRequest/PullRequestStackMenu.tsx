import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
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
import { readableFailure } from "./pullRequestDetail.logic";

import { translateNow } from "~/components/media/translateNow";
import { useT } from "~/hooks/useI18n";
export function PullRequestStackMenu({
  hostLabel,
  terminology,
  stack,
  reference,
  environmentId,
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
  stale: boolean;
  canMerge: boolean;
  canRebase: boolean;
  mergeMethod: PullRequestMergeMethod;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  onActed: () => void;
}) {
  const t = useT();
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
  const rebaseDisabled = pending || stale || hasUnknownHead || hasClosed || unmerged.length === 0;
  const run = async () => {
    const t = translateNow;
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
      title:
        action === "merge" ? t("review.extra.merging.stack") : t("review.extra.rebasing.stack"),
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
        title:
          action === "merge"
            ? t("review.extra.could.not.merge.the.stack")
            : t("review.extra.could.not.rebase.the.stack"),
        description: readableFailure(
          squashAtomCommandFailure(result),
          action === "merge"
            ? t("review.extra.the.host.refused.the.merge.check.that.you")
            : t("review.extra.the.host.refused.the.rebase.a.rebase.stops"),
        ),
      });
    } else {
      toastManager.update(toastId, {
        type: "success",
        title:
          action === "merge"
            ? t("review.extra.stack.merge.request.completed")
            : t("review.extra.stack.rebased"),
        description:
          action === "merge"
            ? translateNow("review.pr.stackMerged", { host: hostLabel })
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
                    aria-label={translateNow("review.pr.stackLayer", {
                      number: stack.number,
                      position,
                      total: stack.layers.length,
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
            {t("review.extra.stackLayer", {
              id: stack.number,
              layer: position,
              total: stack.layers.length,
            })}
            {notice ? ` · ${notice}` : null}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start">
          <MenuGroup>
            <PullRequestStackHeader number={stack.number} notice={notice} stale={!!onRetry} />
            {onRetry ? (
              <MenuItem onClick={onRetry}>{t("review.extra.retry.stack.refresh")}</MenuItem>
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
                  {t("review.extra.mergeStackCount", { count: mergeLayers.length })}
                </MenuItem>
              ) : null}
              {canRebase ? (
                <MenuItem
                  disabled={rebaseDisabled}
                  onClick={() => setConfirmation("update-branch")}
                >
                  <RefreshCwIcon aria-hidden />
                  {t("review.extra.rebase.stack")}
                </MenuItem>
              ) : null}
              {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {t("review.extra.every.layer.being.merged.must.be.open.and")}
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
                  aria-description={stale ? (notice ?? undefined) : undefined}
                  onClick={mergeDisabled ? undefined : () => setConfirmation("merge")}
                >
                  <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                  {t("review.extra.merge.stack")}
                </Button>
              </span>
            }
          />
          <TooltipPopup>
            {stale
              ? notice
              : `Merge stack through #${reference.number} into ${stack.base} (${mergeLayers.length} ${mergeLayers.length === 1 ? terminology.singular : terminology.plural})`}
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
                ? translateNow("review.pr.mergeNTitle", {
                    count: mergeLayers.length,
                    term: mergeLayers.length === 1 ? terminology.singular : terminology.plural,
                  })
                : translateNow("review.pr.rebaseNTitle", {
                    count: unmerged.length,
                    term: unmerged.length === 1 ? terminology.singular : terminology.plural,
                  })}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "merge"
                ? translateNow("review.pr.mergeStackBody", {
                    number: reference.number,
                    base: stack.base,
                    method: mergeMethod,
                    host: hostLabel,
                  })
                : translateNow("review.pr.rebaseStackBody", { base: stack.base })}
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
              {t("review.extra.cancel")}
            </Button>
            <Button onClick={() => void run()}>
              {confirmation === "merge"
                ? t("review.extra.merge.stack")
                : t("review.extra.rebase.stack")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
