import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { folderFromMenuAction, parseFolderName } from "./threadActionMenu.logic";
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

interface FolderNameRequestCopy {
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly initialName: string;
}

type Request = FolderNameRequestCopy & { readonly resolve: (name: string | null) => void };
// `id` remounts the dialog per request, so a replaced request never keeps the old input.
const useRequest = create<{ request: Request | null; id: number }>(() => ({
  request: null,
  id: 0,
}));

function requestFolderName(copy: FolderNameRequestCopy): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState((state) => ({ request: { ...copy, resolve }, id: state.id + 1 })),
  );
}

/** Asks for a folder's new name; `null` when cancelled. */
export function requestFolderRename(current: string): Promise<string | null> {
  return requestFolderName({
    title: msg("Rename folder"),
    description: msg("Renaming onto an existing folder merges the two."),
    submitLabel: msg("Rename", { $context: "verb, confirms renaming a folder" }),
    initialName: current,
  });
}

/** Maps a clicked Folder submenu item to its target; `null` when cancelled. */
export async function resolveFolderMenuAction(
  action: string,
): Promise<{ readonly folder: string | null } | null> {
  if (action === "folder-new") {
    const name = await requestFolderName({
      title: msg("New folder"),
      description: msg("Moved threads leave their project and show under this folder."),
      submitLabel: msg("Move", { $context: "verb, moves threads into a folder" }),
      initialName: "",
    });
    return name === null ? null : { folder: name };
  }
  const folder = folderFromMenuAction(action);
  return folder === undefined ? null : { folder };
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function FolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  const id = useRequest((state) => state.id);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending folder name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <FolderNameDialog key={id} request={request} /> : null;
}

function FolderNameDialog({ request }: { request: FolderNameRequestCopy }) {
  const id = useId();
  const gt = useGT();
  const m = useMessages();
  const [value, setValue] = useState(request.initialName);
  const [invalid, setInvalid] = useState(false);
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
            const name = parseFolderName(value);
            if (name === null) {
              setInvalid(true);
              return;
            }
            finish(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{m(request.title)}</DialogTitle>
            <DialogDescription>{m(request.description)}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={`${id}-name`}>
              <T>Name</T>
              <Input
                nativeInput
                id={`${id}-name`}
                autoFocus
                required
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setInvalid(false);
                }}
              />
            </Label>
            {invalid && (
              <p role="alert" className="text-destructive">
                {gt("Use a single line of at most 64 characters.")}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit">{m(request.submitLabel)}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
