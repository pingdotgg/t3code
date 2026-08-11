import { useEffect, useSyncExternalStore } from "react";

import type { ConfirmDialogResult } from "@t3tools/contracts";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
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

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

export function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

const primaryResult: ConfirmDialogResult = { confirmed: true, secondary: false };
const secondaryResult: ConfirmDialogResult = { confirmed: true, secondary: true };
const cancelledResult: ConfirmDialogResult = { confirmed: false, secondary: false };

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  const message = state.status === "idle" ? "" : state.message;
  const copy = resolveConfirmDialogCopy(message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const confirmLabel = state.status === "idle" ? "Confirm" : (state.confirmLabel ?? "Confirm");
  const cancelLabel = state.status === "idle" ? "Cancel" : (state.cancelLabel ?? "Cancel");
  const secondary = state.status === "idle" ? undefined : state.secondary;

  // A secondary destructive action renders as the lighter `destructive-outline`
  // button so the solid destructive primary stays the visually dominant — and
  // therefore default-reach — choice. The more consequential action should
  // never be the easiest button to hit by reflex.
  const secondaryButtonVariant =
    secondary?.variant === "destructive" ? "destructive-outline" : "outline";

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) respondToConfirmDialog(cancelledResult);
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{cancelLabel}</AlertDialogClose>
          {secondary ? (
            <Button
              variant={secondaryButtonVariant}
              onClick={() => respondToConfirmDialog(secondaryResult)}
            >
              {secondary.label}
            </Button>
          ) : null}
          <Button variant={confirmVariant} onClick={() => respondToConfirmDialog(primaryResult)}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
