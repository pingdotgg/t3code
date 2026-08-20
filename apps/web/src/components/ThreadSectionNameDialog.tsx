import { THREAD_SECTION_NAME_MAX_CHARS } from "@t3tools/contracts";
import { useCallback, useState } from "react";

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

interface DialogRequest {
  readonly mode: "create" | "rename";
  readonly initialName: string;
  readonly existingNames: ReadonlyArray<string>;
  readonly resolve: (name: string | null) => void;
}

export function useThreadSectionNameDialog() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [name, setName] = useState("");

  const requestName = useCallback(
    (input: {
      readonly mode?: "create" | "rename";
      readonly initialName?: string;
      readonly existingNames: ReadonlyArray<string>;
    }) =>
      new Promise<string | null>((resolve) => {
        const initialName = input.initialName ?? "";
        setName(initialName);
        setRequest({
          mode: input.mode ?? "create",
          initialName,
          existingNames: input.existingNames,
          resolve,
        });
      }),
    [],
  );

  const close = useCallback(
    (result: string | null) => {
      request?.resolve(result);
      setRequest(null);
    },
    [request],
  );

  const trimmedName = name.trim();
  const duplicate =
    request !== null &&
    trimmedName !== request.initialName &&
    request.existingNames.some(
      (existingName) => existingName.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
    );
  const valid =
    trimmedName.length > 0 && trimmedName.length <= THREAD_SECTION_NAME_MAX_CHARS && !duplicate;

  const dialog = (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
    >
      <DialogPopup className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) close(trimmedName);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {request?.mode === "rename" ? "Rename section" : "New section"}
            </DialogTitle>
            <DialogDescription>
              Sections keep threads out of the active list until you move them back.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label htmlFor="thread-section-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="thread-section-name"
              autoFocus
              value={name}
              maxLength={THREAD_SECTION_NAME_MAX_CHARS}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Later"
              aria-invalid={duplicate || undefined}
            />
            {duplicate ? (
              <p className="text-xs text-destructive">That section already exists.</p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              {request?.mode === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );

  return { requestName, dialog };
}
