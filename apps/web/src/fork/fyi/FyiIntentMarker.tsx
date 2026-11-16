import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { resolveFyiMarker, type FyiMarker } from "@t3tools/client-runtime/fork/fyi-marker";
import { InfoIcon } from "lucide-react";
import { use } from "react";

import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/** The FYI marker an agent's FYI message shows in place of the steer marker, or null. */
export function useFyiMarker(item: OrchestrationV2TurnItem | undefined): FyiMarker | null {
  const { fyiRuns } = use(TimelineRowCtx);
  const runId = item?.runId ?? null;
  return resolveFyiMarker(item, runId === null ? undefined : fyiRuns.get(runId));
}

export function FyiIntentMarker({ marker }: { readonly marker: FyiMarker }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground"
            data-user-message-intent="fyi"
          />
        }
      >
        <InfoIcon aria-hidden="true" className="size-3" />
        {marker.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{marker.description}</TooltipPopup>
    </Tooltip>
  );
}
