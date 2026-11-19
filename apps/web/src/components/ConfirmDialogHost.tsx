import { msg, T, useMessages } from "gt-react";
import { Trash2Icon } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import type { MessageResolver } from "../i18n/messages";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

// LocalApi.confirm takes one string; translated questions may end in a full-width mark.
const QUESTION_MARK = /[?？]/;

function resolveConfirmDialogCopy(message: string, resolve: MessageResolver): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => QUESTION_MARK.test(line.trim().slice(-1)));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.search(QUESTION_MARK);
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: resolve(msg("Confirm action")),
    description: normalizedMessage || resolve(msg("This action requires your confirmation.")),
  };
}

export function ConfirmDialogHost() {
  const m = useMessages();
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  const copy =
    state.status !== "idle" && state.title
      ? { title: state.title, description: state.message.trim() || null }
      : resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message, m);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const focusConfirm = state.status !== "idle" && state.initialFocus === "confirm";
  const confirmLabel =
    (state.status === "idle" ? undefined : state.confirmLabel) ?? m(msg("Confirm"));
  const showDeleteIcon =
    state.status !== "idle" && confirmVariant === "destructive" && state.deleteIcon === true;
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup className="sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button size="standard" variant="secondary" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          {focusConfirm && confirmVariant === "default" ? (
            <AlertDialogAction size="standard" onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          ) : (
            <Button size="standard" variant={confirmVariant} onClick={onConfirm}>
              {showDeleteIcon ? <Trash2Icon aria-hidden /> : null}
              {confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
