import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MousePointer2Icon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const BrowserAnnotationButton = memo(function BrowserAnnotationButton({
  activeThreadEnvironmentId,
  activeThreadId,
}: {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
}) {
  const [pending, setPending] = useState(false);

  const onClick = useCallback(() => {
    if (pending) {
      return;
    }
    setPending(true);
    void getPrimaryEnvironmentConnection()
      .client.browserAgents.activateAnnotation({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
      })
      .catch((error) => {
        toastManager.add({
          type: "warning",
          title: "Could not start annotation",
          description:
            error instanceof Error
              ? error.message
              : "Open the preview in a paired browser extension first.",
        });
      })
      .finally(() => {
        setPending(false);
      });
  }, [activeThreadEnvironmentId, activeThreadId, pending]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={cn("shrink-0", pending && "border-primary/50 bg-primary/10 text-primary")}
            aria-label="Annotate browser preview"
            disabled={pending}
            onClick={onClick}
          >
            <MousePointer2Icon className="size-3" />
            <span className="ml-0.5">Annotate</span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">Annotate the paired browser preview.</TooltipPopup>
    </Tooltip>
  );
});
