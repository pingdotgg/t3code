import { useEffect, useId, useState } from "react";
import { T, useGT } from "gt-react";
import { create } from "zustand";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const MAX_NAME_LENGTH = 64;

type Request = {
  readonly mode: "create" | "rename";
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a thread folder name; resolves null when dismissed. */
export function requestThreadFolderName(
  mode: Request["mode"],
  initialName = "",
): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { mode, initialName, resolve } }));
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function ThreadFolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <ThreadFolderNameDialog request={request} /> : null;
}

function ThreadFolderNameDialog(props: { request: Request }) {
  const gt = useGT();
  const id = useId();
  const [name, setName] = useState(props.request.initialName);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.request.mode === "create" ? <T>New folder</T> : <T>Rename folder</T>}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={id}>
                <T context="folder name field">Name</T>
              </Label>
              <Input
                id={id}
                autoFocus
                value={name}
                maxLength={MAX_NAME_LENGTH}
                placeholder={gt("Folder name")}
                onChange={(event) => setName(event.target.value.replace(/[\p{Cc}]/gu, ""))}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={trimmed === ""}>
              {props.request.mode === "create" ? <T>Create</T> : <T>Rename</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
