import { msg, T, useMessages } from "gt-react";
import { Trash2Icon } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import { returnKeyboardToFocusedPane } from "../layout/layoutPaneContext";
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
import { useDialogActionInitialFocus } from "./ui/dialog";

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

  const openerRef = useRef<Element | null>(null);
  const { popupRef, initialFocus } = useDialogActionInitialFocus();

  const copy =
    state.status !== "idle" && state.title
      ? { title: state.title, description: state.message.trim() || null }
      : resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message, m);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const focusConfirm = state.status !== "idle" && state.initialFocus === "confirm";
  const confirmLabel =
    (state.status === "idle" ? undefined : state.confirmLabel) ?? m(msg("Confirm"));
  // A destructive "Delete ..." action carries the trash icon.
  const showDeleteIcon = confirmVariant === "destructive" && /^delete\b/i.test(confirmLabel);
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
      <AlertDialogPopup
        ref={popupRef}
        className="sm:max-w-105"
        initialFocus={(openType) => {
          openerRef.current = document.activeElement;
          return initialFocus(openType);
        }}
        finalFocus={() => {
          const opener = openerRef.current;
          if (opener?.isConnected && !opener.closest("[data-layout-strip]")) return true;
          if (returnKeyboardToFocusedPane()) return false;
          // A chat pane takes it in its composer.
          return (
            document.querySelector<HTMLElement>(
              "[data-layout-pane-focused] [contenteditable='true']",
            ) ?? true
          );
        }}
      >
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
