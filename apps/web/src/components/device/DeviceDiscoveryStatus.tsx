import { ChevronDown, CircleAlert } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

export function DeviceDiscoveryStatus(props: { readonly label: string; readonly detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b text-xs text-muted-foreground">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div role="status" className="flex items-center gap-1.5 px-3 py-1.5">
          <CircleAlert className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate">
            Some devices on {props.label} could not be listed.
          </span>
          <CollapsibleTrigger className="flex shrink-0 items-center gap-0.5 hover:text-foreground">
            Details
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <p className="whitespace-pre-wrap break-words px-3 pb-2 font-mono">{props.detail}</p>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
