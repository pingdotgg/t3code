/**
 * Renders one rung of the safety ladder.
 *
 * The descriptors are pure data (`safetyLadder.ts`), so this component owns no
 * copy: whatever the ladder says is what the user reads, in the context menu,
 * the overflow menu and the keyboard path alike.
 *
 * Two rungs need behaviour beyond a yes/no:
 *  - `requireTyped` — the top rung only. Below it, typing a word is theatre,
 *    and theatre trains people to type through dialogs without reading them.
 *  - `repeatConfirm` — deleting an unmerged branch asks a second time.
 *
 * fork: f4 source-control panel
 */
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import type { ConfirmOutcome, PendingSourceControlRequest } from "./useSourceControlConfirm";

export function SourceControlConfirmDialog(props: {
  pending: PendingSourceControlRequest | null;
  onResolve: (outcome: ConfirmOutcome, value?: string) => void;
}) {
  const { pending, onResolve } = props;
  const [typed, setTyped] = useState("");
  const [repeated, setRepeated] = useState(false);
  // fork: f4 F-13 — the free-text rung's value, seeded per request id.
  const [entered, setEntered] = useState("");

  // Reset per request id, so a second confirm never inherits the first's typing.
  useEffect(() => {
    setTyped("");
    setRepeated(false);
    setEntered(pending?.kind === "prompt" ? (pending.options.initialValue ?? "") : "");
    // `pending` is a fresh object exactly once per request, so this is the same
    // "reset per request id" rule stated in a way the dependency check accepts.
  }, [pending]);

  if (!pending) return null;

  if (pending.kind === "prompt") {
    const { options } = pending;
    const value = entered.trim();
    return (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) onResolve("cancelled");
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{options.title}</AlertDialogTitle>
            <AlertDialogDescription>{options.consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6 pb-4">
            <label className="mb-1.5 block text-muted-foreground text-xs" htmlFor="sc-prompt-value">
              {options.inputLabel}
            </label>
            <Input
              id="sc-prompt-value"
              autoFocus
              value={entered}
              onChange={(event) => setEntered(event.target.value)}
              placeholder={options.placeholder ?? ""}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || value.length === 0) return;
                event.preventDefault();
                onResolve("confirmed", value);
              }}
            />
          </div>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => onResolve("cancelled")}>
              Cancel
            </Button>
            <Button disabled={value.length === 0} onClick={() => onResolve("confirmed", value)}>
              {options.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  }

  const { options } = pending;
  const typedSatisfied =
    options.requireTyped === undefined ||
    typed.trim().toLowerCase() === options.requireTyped.toLowerCase();
  const needsRepeat = options.repeatConfirm === true && !repeated;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onResolve("cancelled");
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{options.title}</AlertDialogTitle>
          <AlertDialogDescription>{options.consequence}</AlertDialogDescription>
        </AlertDialogHeader>
        {options.body ? (
          <div className="max-h-40 overflow-auto px-6 pb-4">
            <pre className="whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
              {options.body}
            </pre>
          </div>
        ) : null}
        {options.requireTyped ? (
          <div className="px-6 pb-4">
            <label
              className="mb-1.5 block text-muted-foreground text-xs"
              htmlFor="sc-confirm-typed"
            >
              Type <span className="font-mono text-foreground">{options.requireTyped}</span> to
              confirm
            </label>
            <Input
              id="sc-confirm-typed"
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={options.requireTyped}
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onResolve("cancelled")}>
            Cancel
          </Button>
          {options.alternative ? (
            <Button variant="secondary" onClick={() => onResolve("alternative")}>
              {options.alternative.label}
            </Button>
          ) : null}
          <Button
            variant={options.tone === "danger" ? "destructive" : "default"}
            disabled={!typedSatisfied}
            onClick={() => {
              if (needsRepeat) {
                setRepeated(true);
                return;
              }
              onResolve("confirmed");
            }}
          >
            {needsRepeat ? `${options.confirmLabel} — are you sure?` : options.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
