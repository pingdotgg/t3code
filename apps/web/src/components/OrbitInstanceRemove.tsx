import {
  orbitInstanceGitLine,
  orbitInstanceRemoveAcknowledgesGit,
  orbitInstanceRemoveText,
  type OrbitInstanceGitState,
  type OrbitInstanceRemoveProgress,
  type OrbitInstanceRemoveTarget,
} from "@t3tools/client-runtime/orbit-gateway";
import { CheckIcon, Trash2Icon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Conn: the Instances row's Git line, remove button and remove states, and the remove dialog
 * (DESIGN.md, "Orbit panel and Manage Instances"). The Git line waits for the list's Git state.
 */

/** "Clean", the unsaved work in the warning colour, or "Git state unknown". */
export function OrbitInstanceGitLine({ git }: { readonly git: OrbitInstanceGitState | undefined }) {
  const line = orbitInstanceGitLine(git);
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs",
        line.tone === "warning" ? "text-warning" : "text-muted-foreground",
      )}
      data-orbit-git={line.tone}
    >
      {line.tone === "clean" ? <CheckIcon aria-hidden className="size-3" /> : null}
      {line.text}
    </span>
  );
}

/**
 * Spec Q3, decided by the owner (2026-11-14): while a removal waits for the Instance's setup to
 * stop, the row shows nothing extra, as for any removal: null keeps the row's facts.
 */
export function orbitRemoveWaitTextBehindCompletion(): string | null {
  return null;
}

/**
 * The row's second line while Orbit removes the Instance: its queue place or a plain step; null
 * keeps the row's facts (no step yet, or a step without plain words).
 */
export function orbitInstanceRemovingText(
  progress: OrbitInstanceRemoveProgress | null,
  /** The Instance's setup (its `instance.complete`) still runs: Orbit stops it before removing. */
  completionRunning = false,
): string | null {
  if (progress?.kind === "waiting" && completionRunning) {
    return orbitRemoveWaitTextBehindCompletion();
  }
  if (progress?.kind === "waiting") return "Waiting for another removal to finish";
  if (progress?.kind === "running") return progress.step;
  return null;
}

/** The row's bin button, or "Removing…" while Orbit removes the Instance. */
export function OrbitInstanceRemoveAction(props: {
  readonly removing: boolean;
  readonly onRemove: () => void;
}) {
  if (props.removing) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Spinner className="size-3" />
        Removing…
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Remove Instance"
            onClick={props.onRemove}
          />
        }
      >
        <Trash2Icon />
      </TooltipTrigger>
      <TooltipPopup side="top">Remove Instance</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A failed remove stays on the row with Retry, which sends the destroy again with the same tick.
 * "Could not remove" when Orbit refused before it started; "Removal failed" when it started.
 */
export function OrbitInstanceRemoveFailure(props: {
  readonly refused: boolean;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <span className="flex items-center gap-1.5 text-destructive-foreground text-xs" role="alert">
      <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0">
        {props.refused ? "Could not remove" : "Removal failed"}: {props.message}
      </span>
      <button
        type="button"
        className="shrink-0 text-foreground underline underline-offset-2 hover:no-underline"
        onClick={props.onRetry}
      >
        Retry
      </button>
    </span>
  );
}

function RemoveDialogBody(props: {
  readonly target: OrbitInstanceRemoveTarget;
  readonly checking: boolean;
  readonly onConfirm: (
    acknowledgeUnsaved: boolean,
    shownGit: OrbitInstanceGitState | undefined,
  ) => void;
}) {
  const text = orbitInstanceRemoveText(props.target);
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = props.checking || (text.acknowledge !== null && !acknowledged);
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{text.title}</AlertDialogTitle>
        <AlertDialogDescription>
          {text.before}
          <span className="font-medium text-foreground">{text.target}</span>
          {text.after}
        </AlertDialogDescription>
        {text.warning === null ? null : (
          <div
            className="mt-2 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-start text-foreground text-sm"
            data-orbit-remove-warning={text.warning.kind}
          >
            <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            {text.warning.kind === "unknown" ? (
              <p>{text.warning.text}</p>
            ) : (
              <div>
                <p className="font-medium">{text.warning.heading}</p>
                <ul className="mt-1 list-disc ps-4 text-muted-foreground">
                  {text.warning.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {text.acknowledge === null ? null : (
          <label className="mt-1 flex cursor-pointer items-center gap-2 text-start text-foreground text-sm">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            {text.acknowledge}
          </label>
        )}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button
          variant="destructive"
          disabled={blocked}
          // A tick that only stops working threads (no Git facts, clean, or no Git state) keeps
          // Orbit's own read at the destroy: `instance.unsaved_work` then asks again.
          onClick={() =>
            props.onConfirm(
              text.acknowledge !== null && orbitInstanceRemoveAcknowledgesGit(props.target.git),
              props.target.git,
            )
          }
        >
          Remove Instance
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/**
 * Remove always asks once. Unsaved work, a working thread or an unknown Git state also needs the
 * tick; Remove Instance stays off until it is set, and while `checking` (Orbit's Git read when the
 * dialog opened, at most a short moment). `onConfirm` gets whether the tick was asked.
 */
export function OrbitInstanceRemoveDialog(props: {
  readonly target: OrbitInstanceRemoveTarget | null;
  readonly checking?: boolean;
  readonly onCancel: () => void;
  /** `shownGit`: the Git state the dialog showed at the click. */
  readonly onConfirm: (
    acknowledgeUnsaved: boolean,
    shownGit: OrbitInstanceGitState | undefined,
  ) => void;
}) {
  const { target } = props;
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <AlertDialogPopup>
        {target === null ? null : (
          // A new target or Orbit's newer Git state asks for the tick again.
          <RemoveDialogBody
            key={`${target.name}:${JSON.stringify(target.git)}:${target.workingCount}`}
            target={target}
            checking={props.checking === true}
            onConfirm={props.onConfirm}
          />
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
