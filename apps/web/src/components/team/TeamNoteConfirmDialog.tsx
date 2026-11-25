import { T, useGT } from "gt-react";
import { ShieldAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

export function TeamNoteConfirmDialog({
  open,
  authorPseudo,
  exactText,
  actionLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly authorPseudo: string;
  readonly exactText: string;
  readonly actionLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  if (!open) return null;

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="team-note-confirm-dialog">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <ShieldAlertIcon className="size-4 text-warning-foreground" aria-hidden />
              <T>Confirm note text before sending to agent</T>
            </span>
          </DialogTitle>
          <DialogDescription>
            {gt(
              "Review the exact text from {author} that will be included in the prompt on your environment:",
              { author: authorPseudo },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <pre
            data-testid="team-note-confirm-exact-text"
            className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-xs text-foreground"
          >
            {exactText}
          </pre>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="team-note-confirm-cancel"
            onClick={onCancel}
          >
            <T>Cancel</T>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            data-testid="team-note-confirm-submit"
            onClick={onConfirm}
          >
            {busy ? <Spinner size="xs" /> : null}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
