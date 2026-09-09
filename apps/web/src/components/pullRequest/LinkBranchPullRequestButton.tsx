import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link2 } from "lucide-react";
import { useState } from "react";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Adopts a branch discovery as a durable link, even after the thread changes branches. */
export function LinkBranchPullRequestButton({
  threadRef,
  url,
}: {
  threadRef: ScopedThreadRef;
  url: string;
}) {
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);
  if (!linking.canLink(url)) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-tiny"
            variant="ghost-muted"
            aria-label="Link this PR"
            disabled={pending}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              setPending(true);
              try {
                await linking.changeLink(threadRef, url, true);
              } catch (error) {
                toastManager.add({
                  type: "error",
                  title: "Could not link pull request",
                  description: error instanceof Error ? error.message : String(error),
                });
              } finally {
                setPending(false);
              }
            }}
          >
            <Link2 className="size-3" />
          </Button>
        }
      />
      <TooltipPopup>Link this PR to keep it with this thread</TooltipPopup>
    </Tooltip>
  );
}
