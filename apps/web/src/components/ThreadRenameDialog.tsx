import { useEffect, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

type Request = {
  readonly title: string;
  readonly resolve: (title: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Resolves the trimmed new title, or null when cancelled or unchanged. */
export function requestThreadRename(title: string): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { title, resolve } }));
}

function finish(title: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(title !== null && title !== request.title ? title : null);
}

export function ThreadRenameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending rename request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <ThreadRenameDialog initialTitle={request.title} /> : null;
}

function ThreadRenameDialog({ initialTitle }: { readonly initialTitle: string }) {
  const [title, setTitle] = useState(initialTitle);
  const trimmed = title.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Chat title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
