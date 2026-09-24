import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ConfirmDialogCheckboxOptions, ConfirmDialogVariant } from "@t3tools/contracts";

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
import { Checkbox } from "./ui/checkbox";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
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

type ConfirmDialogBodyProps = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly checkbox?: ConfirmDialogCheckboxOptions | undefined;
  readonly onConfirm: () => void;
};

function ConfirmDialogBody({ message, variant, checkbox, onConfirm }: ConfirmDialogBodyProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const checkboxRef = useRef<HTMLButtonElement | null>(null);

  const [checkboxChecked, setCheckboxChecked] = useState(checkbox?.checked ?? false);

  const copy = resolveConfirmDialogCopy(message);

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (target === confirmButtonRef.current) {
        event.preventDefault();
        cancelButtonRef.current?.focus();
      } else if (target === cancelButtonRef.current) {
        event.preventDefault();
        confirmButtonRef.current?.focus();
      }
    } else if (event.key === "ArrowUp") {
      if (
        checkboxRef.current &&
        (target === confirmButtonRef.current || target === cancelButtonRef.current)
      ) {
        event.preventDefault();
        checkboxRef.current.focus();
      }
    } else if (event.key === "ArrowDown") {
      if (checkboxRef.current && target === checkboxRef.current) {
        event.preventDefault();
        confirmButtonRef.current?.focus();
      }
    }
  };

  return (
    <AlertDialogPopup initialFocus={confirmButtonRef}>
      <AlertDialogHeader>
        <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        {copy.description ? (
          <AlertDialogDescription className="whitespace-pre-line">
            {copy.description}
          </AlertDialogDescription>
        ) : null}
      </AlertDialogHeader>
      <AlertDialogFooter
        className={
          checkbox ? "flex-col-reverse sm:flex-row sm:items-center sm:justify-between" : undefined
        }
        onKeyDown={handleKeyDown}
      >
        {checkbox ? (
          <div className="mb-2 sm:mb-0">
            <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground select-none sm:self-center">
              <Checkbox
                ref={checkboxRef}
                checked={checkboxChecked}
                onCheckedChange={(checked) => {
                  const next = checked === true;
                  setCheckboxChecked(next);
                  checkbox.onCheckedChange?.(next);
                }}
              />
              <span>{checkbox.label}</span>
            </label>
          </div>
        ) : null}
        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <AlertDialogClose ref={cancelButtonRef} render={<Button variant="outline" />}>
            Cancel
          </AlertDialogClose>
          <Button ref={confirmButtonRef} autoFocus variant={variant} onClick={onConfirm}>
            Confirm
          </Button>
        </div>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  const isMounted = state.status === "confirming" || state.status === "closing";

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
      {isMounted ? (
        <ConfirmDialogBody
          key={state.message}
          message={state.message}
          variant={state.variant}
          checkbox={state.checkbox}
          onConfirm={onConfirm}
        />
      ) : null}
    </AlertDialog>
  );
}
