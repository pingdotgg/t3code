import { useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  answerThreadMoveDialog,
  readThreadMoveDialog,
  subscribeThreadMoveDialog,
} from "./threadMoveDialogStore";

function FolderRow({ label, path }: { readonly label: string; readonly path: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0">{label}</dt>
      <dd className={path === null ? undefined : "wrap-anywhere font-mono text-xs leading-5"}>
        {path ?? "A new scratch folder"}
      </dd>
    </div>
  );
}

/** Asks before `/cd` or `/no` adds a project or leaves a worktree or scratch folder. */
export function ThreadMoveDialog() {
  const copy = useSyncExternalStore(
    subscribeThreadMoveDialog,
    readThreadMoveDialog,
    readThreadMoveDialog,
  );
  // The popup keeps its last text while it closes.
  const [shown, setShown] = useState(copy);
  if (copy !== null && copy !== shown) setShown(copy);

  return (
    <AlertDialog
      open={copy !== null}
      onOpenChange={(open) => {
        if (!open) answerThreadMoveDialog(false);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle size="compact">{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2">
            <dl className="flex flex-col gap-1">
              {shown?.from != null ? <FolderRow label="From" path={shown.from} /> : null}
              <FolderRow label="To" path={shown?.to ?? null} />
            </dl>
            {shown?.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={() => answerThreadMoveDialog(true)}>{shown?.confirmLabel}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
