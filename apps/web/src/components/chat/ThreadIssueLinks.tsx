import type { ScopedThreadRef } from "@t3tools/contracts";
import { CircleDotIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function ThreadIssueLinks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const update = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const issues = thread?.issues ?? [];
  if (!thread || issues.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />} aria-label="Linked issues">
        <CircleDotIcon aria-hidden className="size-3.5" />
        {issues.length}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80">
        <PopoverTitle className="mb-2 text-sm">Linked issues</PopoverTitle>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {issues.map((issue) => (
            <div
              key={JSON.stringify([issue.provider, issue.repository, issue.number])}
              className="flex items-center gap-1"
            >
              <button
                type="button"
                className="min-w-0 flex-1 rounded-sm px-1 py-1 text-left text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  useRightPanelStore.getState().openIssue(threadRef, {
                    environmentId: threadRef.environmentId,
                    projectId: thread.projectId,
                    provider: issue.provider,
                    repository: issue.repository,
                    number: issue.number,
                  })
                }
              >
                <span className="block truncate font-medium">{issue.title}</span>
                <span className="text-muted-foreground">
                  {issue.repository} · {issue.number}
                </span>
              </button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Unlink ${issue.title}`}
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    await update({
                      environmentId: threadRef.environmentId,
                      input: {
                        threadId: threadRef.threadId,
                        issueUnlink: {
                          provider: issue.provider,
                          repository: issue.repository,
                          number: issue.number,
                        },
                      },
                    });
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <UnlinkIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
