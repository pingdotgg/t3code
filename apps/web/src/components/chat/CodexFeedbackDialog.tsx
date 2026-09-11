import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

export function CodexFeedbackDialog({
  onSubmit,
  onCancel,
}: {
  readonly onSubmit: (reason?: string) => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const inputId = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(reason.trim() || undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>Send feedback to OpenAI</DialogTitle>
            <DialogDescription>
              Share this Codex thread and its logs. You can add details about what went wrong.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 px-6 py-4">
            <label htmlFor={inputId} className="text-sm font-medium">
              Details (optional)
            </label>
            <Textarea
              id={inputId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What happened?"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Send feedback</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
