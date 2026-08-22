import { resolveSnoozeForDefault } from "@t3tools/client-runtime/state/thread-settled";
import { type FormEvent, useState, useSyncExternalStore } from "react";

import {
  closeSnoozeForDialog,
  readSnoozeForDialogState,
  subscribeSnoozeForDialog,
  type SnoozeForDialogState,
} from "../snoozeForDialog";
import { formatSnoozeForInput, parseSnoozeForInput } from "./Sidebar.snooze";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const FORM_ID = "snooze-for-form";

function SnoozeForForm(props: {
  readonly request: Extract<SnoozeForDialogState, { readonly status: "open" }>;
}) {
  const { request } = props;
  const [input, setInput] = useState(() =>
    formatSnoozeForInput(resolveSnoozeForDefault(new Date())),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Re-read the clock here: a valid value can expire while the dialog is open.
    const result = parseSnoozeForInput(input, { now: new Date() });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    closeSnoozeForDialog();
    request.onSnooze(result.value.toISOString());
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Snooze until</DialogTitle>
        <DialogDescription>
          Choose when {request.threadCount === 1 ? "this thread" : "these threads"} should return to
          your inbox.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={FORM_ID} className="space-y-2" noValidate onSubmit={submit}>
          <Label htmlFor="snooze-for-time">Date and time</Label>
          <Input
            id="snooze-for-time"
            type="datetime-local"
            step={15 * 60}
            autoFocus
            value={input}
            aria-invalid={error !== null}
            aria-describedby={error ? "snooze-for-error" : undefined}
            onChange={(event) => {
              setInput(event.currentTarget.value);
              if (error) setError(null);
            }}
          />
          {error ? (
            <p id="snooze-for-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeSnoozeForDialog}>
          Cancel
        </Button>
        <Button form={FORM_ID} type="submit">
          Snooze
        </Button>
      </DialogFooter>
    </>
  );
}

export function SnoozeForDialogHost() {
  const state = useSyncExternalStore(
    subscribeSnoozeForDialog,
    readSnoozeForDialogState,
    readSnoozeForDialogState,
  );

  return (
    <Dialog
      open={state.status === "open"}
      onOpenChange={(open) => {
        if (!open) closeSnoozeForDialog();
      }}
    >
      <DialogPopup className="max-w-sm">
        {state.status === "open" ? <SnoozeForForm key={state.id} request={state} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
