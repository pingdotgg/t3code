/**
 * The panel's ONE status slot, directly above the list.
 *
 * fork: f4 redesign (audit §8 D) — "something is wrong" used to appear in two
 * unrelated places with two hand-built treatments: a `bg-destructive/8` read
 * error above the tab bar, and a `bg-amber-500/5` conflicts band below the
 * composer (amber with no dark pair, so in dark mode it was a ~2% lift and lost
 * its warning identity entirely). Both are now one `Alert` in one place.
 *
 * Precedence, when both could show: the read error wins. A failed
 * `workingCopy.status` means the list underneath may be stale or wrong, and
 * that has to be said before anything derived from it.
 *
 * The conflicted FILES are not repeated here — they are rows in the list below,
 * in their own non-collapsible group, with per-path Ours/Theirs/Mark-resolved
 * rungs on the row itself. The band carries only what is true of the operation
 * as a whole.
 *
 * Detect and surface, do NOT automate: for anything other than a merge the
 * panel tells the user to run `git <op> --continue` in the terminal — which t3
 * has inline — rather than driving it through a non-interactive subprocess.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyOperation } from "@t3tools/contracts";
import { AlertCircle, AlertTriangle, X } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { operationGuidance } from "./sourceControlPanel.logic";

export interface SourceControlStatusBandProps {
  /** A `workingCopy.status` read failed and has not been dismissed. */
  readonly error: string | null;
  readonly onDismissError: () => void;
  /** A merge/rebase/cherry-pick/revert is stopped mid-flight. */
  readonly operation: WorkingCopyOperation | null;
  readonly conflictCount: number;
  /** Any action is in flight — Continue waits for it. */
  readonly busy: boolean;
  readonly abortBusy: boolean;
  /**
   * fork: f4 F-11 — "Commit merge" commits the composer's draft, which is
   * usually empty at this point. It used to fire anyway and hand the user a red
   * git stderr toast with no clue that the box below was the input.
   */
  readonly hasMessage: boolean;
  /** `default` only when this band owns the panel's one primary slot. */
  readonly primaryVariant: "default" | "secondary";
  readonly onAbort: () => void;
  readonly onContinue: () => void;
}

export function SourceControlStatusBand(props: SourceControlStatusBandProps) {
  if (props.error !== null) {
    return (
      <div className="flex-none px-3 py-2">
        <Alert variant="error" className="px-3 py-2">
          <AlertCircle />
          <AlertTitle className="text-xs">The working copy could not be read</AlertTitle>
          <AlertDescription className="text-xs">
            <span className="line-clamp-3 break-words">{props.error}</span>
          </AlertDescription>
          <AlertAction>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Dismiss"
                    onClick={props.onDismissError}
                  />
                }
              >
                <X />
              </TooltipTrigger>
              <TooltipPopup>Dismiss</TooltipPopup>
            </Tooltip>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  if (props.operation === null) {
    return null;
  }

  const guidance = operationGuidance(props.operation);
  const remaining = props.conflictCount;
  const continueBlockedReason =
    remaining > 0
      ? `${remaining} file${remaining === 1 ? " is" : "s are"} still conflicted`
      : // Deliberately not "below": the band shows on both tabs, and the
        // composer is only on Changes.
        !props.hasMessage
        ? "Write a commit message first"
        : props.busy
          ? "Another action is still running"
          : null;

  return (
    <div className="flex-none px-3 py-2">
      <Alert variant="warning" className="px-3 py-2" aria-label={guidance.title}>
        <AlertTriangle />
        <AlertTitle className="text-xs">{guidance.title}</AlertTitle>
        <AlertDescription className="text-xs">
          <span>
            {remaining === 0
              ? "All conflicts resolved."
              : `${remaining} file${remaining === 1 ? "" : "s"} still conflicted.`}
            {guidance.canContinueInPanel ? null : ` ${guidance.terminalHint}`}
          </span>
        </AlertDescription>
        <AlertAction>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={props.abortBusy}
            onClick={props.onAbort}
          >
            {props.abortBusy ? "Aborting…" : "Abort"}
          </Button>
          {guidance.canContinueInPanel ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  size="xs"
                  variant={props.primaryVariant}
                  disabled={continueBlockedReason !== null}
                  onClick={props.onContinue}
                >
                  {guidance.continueLabel}
                </Button>
              </TooltipTrigger>
              <TooltipPopup>{continueBlockedReason ?? guidance.continueLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
        </AlertAction>
      </Alert>
      {/* The blocked reason stays visible, not only in the tooltip: a greyed
          button with no stated reason is the defect F-11 was raised for. */}
      {guidance.canContinueInPanel && continueBlockedReason !== null ? (
        <p className="px-1 pt-1 text-[11px] text-muted-foreground">{continueBlockedReason}</p>
      ) : null}
    </div>
  );
}
