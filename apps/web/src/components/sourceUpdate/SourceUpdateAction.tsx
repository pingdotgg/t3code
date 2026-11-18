import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { CircleArrowUpIcon, CircleStopIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  canCancelSourceUpdate,
  canRunSourceUpdate,
  sourceUpdateSummary,
} from "./sourceUpdate.logic";
import { useSourceUpdateActions, useSourceUpdateState } from "./useSourceUpdate";

/** Status or progress text; `full` also describes an up-to-date checkout. */
export function SourceUpdateStatus({
  environmentId,
  full = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly full?: boolean;
}) {
  const { status, failed, phase } = useSourceUpdateState(environmentId);
  const gt = useGT();
  const messages = useMessages();
  if (phase.kind === "resolving") {
    return (
      <T>
        <span className="text-xs">
          Upstream has conflicts; an agent is resolving them in{" "}
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(scopeThreadRef(environmentId, phase.threadId))}
            className="underline"
          >
            this thread
          </Link>
          . Press Update once it pushes.
        </span>
      </T>
    );
  }
  const text =
    sourceUpdateSummary(phase, messages) ??
    (!full
      ? null
      : status !== null
        ? (status.updateUnavailableReason ?? gt("Up to date at {sha}", { sha: status.head.sha }))
        : failed
          ? gt("Could not read the source checkout. Check the server log.")
          : gt("Checking the checkout…"));
  if (text === null) return null;
  return (
    <span className={phase.kind === "failed" ? "text-destructive text-xs" : "text-xs"}>{text}</span>
  );
}

/** T3's server Update button for an environment that runs from a source checkout. */
export function SourceUpdateButton({
  environmentId,
  size = "xs",
  appearance = "button",
}: {
  readonly environmentId: EnvironmentId;
  readonly size?: ComponentProps<typeof Button>["size"];
  readonly appearance?: "button" | "icon";
}) {
  const { status, phase } = useSourceUpdateState(environmentId);
  const { update, cancel } = useSourceUpdateActions();
  const gt = useGT();
  const cancellable = canCancelSourceUpdate(phase);
  if (!cancellable && !canRunSourceUpdate(status, phase)) return null;
  const label = cancellable
    ? gt("Cancel update")
    : phase.kind === "failed"
      ? gt("Retry update")
      : gt("Update", { $context: "verb, updates the server from source" });
  const onClick = () => void (cancellable ? cancel(environmentId) : update(environmentId));
  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />
          }
        >
          {cancellable ? (
            <CircleStopIcon className="size-3.5" />
          ) : (
            <CircleArrowUpIcon className="size-3.5" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Button size={size} variant="outline" onClick={onClick}>
      {label}
    </Button>
  );
}
