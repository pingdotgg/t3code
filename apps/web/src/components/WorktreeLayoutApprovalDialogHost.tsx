import type { WorktreeLayoutCommandKind } from "@t3tools/contracts";
import { msg, T, useMessages, Var } from "gt-react";
import { useSyncExternalStore } from "react";

import {
  readWorktreeLayoutApprovalState,
  respondToWorktreeLayoutApproval,
  subscribeWorktreeLayoutApprovalHost,
} from "../worktreeLayoutApproval";
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

export const WORKTREE_LAYOUT_COMMAND_LABELS: Record<WorktreeLayoutCommandKind, string> = {
  create: msg("Runs when a worktree thread starts, and when its folder is restored"),
  remove: msg("Runs when a thread's worktree is removed"),
};

/** Asks before a project's own worktree commands run for the first time, or after they change. */
export function WorktreeLayoutApprovalDialogHost() {
  const m = useMessages();
  const { request, open } = useSyncExternalStore(
    subscribeWorktreeLayoutApprovalHost,
    readWorktreeLayoutApprovalState,
    readWorktreeLayoutApprovalState,
  );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && request !== null) respondToWorktreeLayoutApproval(request.id, false);
      }}
    >
      <AlertDialogPopup className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Let this project run its worktree commands?</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>
              <Var>{request?.projectTitle ?? ""}</Var> sets up worktree threads with its own
              commands from <code>t3.json</code>. They run on this environment's machine with your
              permissions, outside any agent sandbox. You are asked again whenever their text
              changes.
            </T>
          </AlertDialogDescription>
          <div className="flex flex-col gap-3 pt-2 text-left">
            {request?.commands.map((command) => (
              <div key={command.kind} className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted-foreground">
                  {m(WORKTREE_LAYOUT_COMMAND_LABELS[command.kind])}
                </span>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-control surface-well px-3 py-2 font-mono text-caption">
                  {command.command}
                </pre>
              </div>
            ))}
          </div>
        </AlertDialogHeader>
        {/* New buttons for each request: a press begun on one request cannot answer the next. */}
        <AlertDialogFooter key={request?.id}>
          <AlertDialogClose render={<Button variant="secondary" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button
            onClick={() => {
              // The request whose commands this render shows, not whichever is pending by now.
              if (request !== null) respondToWorktreeLayoutApproval(request.id, true);
            }}
          >
            <T>Approve and continue</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
