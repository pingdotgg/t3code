import type { ScopedThreadRef } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useQuietThreadProjection } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { summarizeMcpCalls } from "./threadDetailsMcp.logic";

export function ThreadDetailsMcp({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const projection = useQuietThreadProjection(threadRef);
  const servers = summarizeMcpCalls(projection?.projection.turnItems ?? []);
  if (servers.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-mcp-heading"
      title={gt("MCPs")}
      actions={
        <span className="pr-2 text-xs text-muted-foreground tabular-nums">
          {servers.length} <T>used</T>
        </span>
      }
    >
      <ScrollArea className="max-h-40">
        <ul data-thread-details-mcp className="px-2.5 text-xs">
          {servers.map(({ server, calls }) => (
            <li key={server} className="flex min-h-7 items-center gap-2.5">
              <PlugIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 flex-1 truncate">{server}</span>}
                />
                <TooltipPopup>{server}</TooltipPopup>
              </Tooltip>
              <span className="text-muted-foreground tabular-nums">
                {calls} <T>calls</T>
              </span>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </ThreadDetailsSection>
  );
}
