import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { ClaudeProjectCommandList, useClaudeProjectTrust } from "../ClaudeProjectTrust";
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

type Trust = ReturnType<typeof useClaudeProjectTrust>;

/**
 * A Claude thread below Full access in a project nobody trusted, whose folder would run something:
 * the composer banner that asks, and the dialog that shows what would run and records the trust.
 * `threadId` is undefined for a thread that has not started; its project's folder is read then.
 */
export function useClaudeProjectTrustBanner(input: {
  readonly projectRef: ScopedProjectRef | null;
  readonly threadId: ThreadId | undefined;
  /** The thread runs Claude and is not in Full access, where everything runs without asking. */
  readonly enabled: boolean;
}): ComposerBannerStackItem | null {
  const gt = useGT();
  const trust = useClaudeProjectTrust(
    input.enabled && input.projectRef !== null
      ? { ...input.projectRef, threadId: input.threadId }
      : null,
  );
  const shown = trust.query.data;
  if (input.projectRef === null || shown?.status !== "untrusted" || shown.commands.length === 0) {
    return null;
  }
  return {
    id: `claude-project-trust:${input.projectRef.projectId}`,
    variant: "warning",
    icon: <ShieldAlertIcon />,
    title: gt("Trust this project's Claude Code settings?"),
    description: gt(
      "Until you do, Claude sessions here run without the project's hooks, helper commands, MCP servers and environment variables.",
    ),
    actions: <ReviewClaudeProjectTrust trust={trust} />,
  };
}

function ReviewClaudeProjectTrust({ trust }: { trust: Trust }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Review</T>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              <T>Trust this project's Claude Code settings?</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                A trusted project runs everything its Claude Code settings name, in every Claude
                thread of the project: hooks, helper commands, MCP servers and environment
                variables. They run on this environment's machine with your permissions, outside any
                agent sandbox. You are asked once per project, not again when the settings change.
                This is what they hold now. Trust applies from the next session on.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ClaudeProjectCommandList commands={trust.query.data?.commands ?? []} />
            {trust.canTrust ? null : (
              <p className="pt-3 text-xs text-muted-foreground">
                <T>
                  This connection cannot trust a project. Use a client that can use the terminal.
                </T>
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              <T>Not now</T>
            </DialogClose>
            <Button
              disabled={!trust.canTrust || trust.saving || trust.query.isPending}
              onClick={() => {
                void trust.save(true).then((trusted) => {
                  if (trusted) setOpen(false);
                });
              }}
            >
              <T>Trust project</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
