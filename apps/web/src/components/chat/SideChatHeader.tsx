import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  describeSideChatVisibility,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpFromLineIcon, MoreHorizontalIcon, PenLineIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  SIDE_CHAT_EDITABLE_RUNTIME_MODE,
  useSideChatActions,
} from "../../hooks/useSideChatActions";
import { serverEnvironment } from "../../state/server";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Top of an embedded side chat. States what the chat can see of its parent and
 * holds the ways out: allow edits, bring the answer back, promote, discard.
 */
export function SideChatHeader(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const navigate = useNavigate();
  const childRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(childRef);
  const childProjection = useThreadProjection(childRef)?.projection ?? null;
  const parentThreadId = shell?.lineage.parentThreadId ?? null;
  const parentRef =
    parentThreadId === null ? null : scopeThreadRef(props.environmentId, parentThreadId);
  const parentProjection = useThreadProjection(parentRef)?.projection ?? null;
  const actions = useSideChatActions(parentRef);
  const [busy, setBusy] = useState(false);
  // The composer's own permission pick is what the next send uses, so the
  // switch reflects it before falling back to the thread's mode.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(childRef)?.runtimeMode ?? null,
  );
  // A provider without auto-accept-edits would fall back to asking, so the
  // switch must not claim edits are allowed there.
  const providerInstanceId = shell?.runtime?.providerInstanceId ?? shell?.modelSelection.instanceId;
  const canAllowEdits = useAtomValue(
    serverEnvironment.providersValueAtom(props.environmentId),
    (providers) => {
      const modes = providers?.find(
        (provider) => provider.instanceId === providerInstanceId,
      )?.supportedRuntimeModes;
      return (
        modes === undefined || modes.length === 0 || modes.includes(SIDE_CHAT_EDITABLE_RUNTIME_MODE)
      );
    },
  );

  if (shell === null) return null;
  const allowEdits = (composerRuntimeMode ?? shell.runtimeMode) !== "approval-required";
  const mergeRun = childProjection === null ? null : resolveLatestMergeBackRun(childProjection);
  const canBringBack = shell.lineage.relationshipToParent === "fork" && mergeRun !== null;
  const bringBackReason =
    shell.lineage.relationshipToParent !== "fork"
      ? "This side chat started without history, so there is nothing to merge from."
      : mergeRun === null
        ? "Wait for a reply in this side chat first."
        : null;

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await Promise.resolve()
      .then(action)
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border/65 px-3"
      data-side-chat-header
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge variant="outline" className="shrink-0">
              {describeSideChatVisibility({
                forkedFrom: shell.forkedFrom,
                parentRuns: parentProjection?.runs ?? null,
              })}
            </Badge>
          }
        />
        <TooltipPopup side="bottom">
          {shell.forkedFrom?.type === "run"
            ? "Forked from the last finished run, so work still in progress is not included."
            : "Linked to the main thread without its history."}
        </TooltipPopup>
      </Tooltip>
      <span className="min-w-0 flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <PenLineIcon aria-hidden className="size-3" />
              Allow edits
              <Switch
                size="sm"
                checked={allowEdits}
                disabled={busy || (!allowEdits && !canAllowEdits)}
                onCheckedChange={(checked) =>
                  void run(() => actions.setAllowEdits(props.threadId, checked))
                }
              />
            </label>
          }
        />
        <TooltipPopup side="bottom">
          {canAllowEdits
            ? "Shares the main thread's files. Off, it asks before changing anything."
            : "This provider can't approve only edits automatically."}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button size="icon-xs" variant="ghost" aria-label="Side chat actions" disabled={busy} />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-56">
          <MenuItem
            disabled={!canBringBack}
            onClick={() =>
              mergeRun !== null && void run(() => actions.bringBack(props.threadId, mergeRun.id))
            }
          >
            <ArrowUpFromLineIcon className="size-3.5" />
            {canBringBack ? "Bring back to main" : (bringBackReason ?? "Bring back to main")}
          </MenuItem>
          <MenuItem
            onClick={() =>
              void run(async () => {
                if (await actions.promote(props.threadId)) {
                  await navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(childRef),
                  });
                }
              })
            }
          >
            Promote to thread
          </MenuItem>
          <MenuItem
            variant="destructive"
            onClick={() => void run(() => actions.discard(props.threadId))}
          >
            <Trash2Icon className="size-3.5" />
            Discard
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
