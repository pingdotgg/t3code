import type { IssueFieldValues, IssueState } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { IssueNativeFields, nativeFieldError, nativeFieldValues } from "./IssueNativeFields";

export function IssueStateFieldsDialog({
  state,
  pending,
  allowed,
  commentPosted,
  onSubmit,
  onCancel,
}: {
  state: IssueState;
  pending: boolean;
  allowed: boolean;
  commentPosted: boolean;
  onSubmit: (values: IssueFieldValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<IssueFieldValues>({});
  const fields = state.fields ?? [];
  const error = nativeFieldError(fields, values);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Change state to {state.name}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <IssueNativeFields
            fields={fields}
            values={values}
            onChange={setValues}
            disabled={pending || !allowed}
          />
          {commentPosted ? (
            <p role="status" className="text-sm">
              The comment was posted. Retry to change the state.
            </p>
          ) : null}
          {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
          {!allowed ? <p role="alert">You cannot change the state here.</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending || !allowed || error !== null}
            onClick={() => onSubmit(nativeFieldValues(fields, values))}
          >
            {pending ? "Saving…" : "Change state"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
