import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { ClaudeProjectHookList, useClaudeProjectHooks } from "../ClaudeProjectHooks";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { type ComposerBannerStackItem } from "./ComposerBannerStack";

type Hooks = ReturnType<typeof useClaudeProjectHooks>;

/**
 * A Claude thread below Full access whose folder declares hooks nobody approved: the composer
 * banner that says they do not run, and the dialog that shows them in full and approves them.
 * `threadId` is undefined for a thread that has not started; its project's folder is read then.
 */
export function useClaudeProjectHooksBanner(input: {
  readonly projectRef: ScopedProjectRef | null;
  readonly threadId: ThreadId | undefined;
  /** The thread runs Claude and is not in Full access, where the hooks run without asking. */
  readonly enabled: boolean;
}): ComposerBannerStackItem | null {
  const gt = useGT();
  const hooks = useClaudeProjectHooks(
    input.enabled && input.projectRef !== null
      ? { ...input.projectRef, threadId: input.threadId }
      : null,
  );
  const shown = hooks.query.data;
  if (input.projectRef === null || shown?.status !== "needs-approval") return null;
  return {
    id: `claude-project-hooks:${input.projectRef.projectId}:${shown.hooksHash}`,
    variant: "warning",
    icon: <ShieldAlertIcon />,
    title: gt("This project's Claude hooks are waiting for your approval"),
    description: gt("Claude sessions here run without them until you approve."),
    actions: <ReviewClaudeProjectHooks hooks={hooks} />,
  };
}

function ReviewClaudeProjectHooks({ hooks }: { hooks: Hooks }) {
  const [open, setOpen] = useState(false);
  const shown = hooks.query.data;
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Review</T>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              <T>Let this project run its Claude hooks?</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                This project's Claude Code settings run their own commands when a session starts,
                when you send a prompt, and around tool calls. They run on this environment's
                machine with your permissions, outside any agent sandbox. Once approved they run in
                every Claude thread of this project, starting with the next session. You are asked
                again whenever they change.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ClaudeProjectHookList hooks={shown?.hooks ?? []} />
            {hooks.canApprove ? null : (
              <p className="pt-3 text-xs text-muted-foreground">
                <T>This connection cannot approve hooks. Use a client that can use the terminal.</T>
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              <T>Not now</T>
            </DialogClose>
            <Button
              disabled={!hooks.canApprove || hooks.saving || hooks.query.isPending}
              onClick={() => {
                void hooks.save(true).then((approved) => {
                  if (approved) setOpen(false);
                });
              }}
            >
              <T>Approve hooks</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
