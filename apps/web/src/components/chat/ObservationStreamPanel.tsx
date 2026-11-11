import {
  OPEN_OBSERVATION_STATUSES,
  type ObservationItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { RadioIcon } from "lucide-react";

import { useQuietThreadProjection } from "~/state/entities";

function statusLabel(status: ObservationItem["status"]): string {
  switch (status) {
    case "open":
      return "Open";
    case "linked":
      return "Linked";
    case "declined":
      return "Declined";
    case "duplicated":
      return "Duplicate";
  }
}

export function ObservationStreamPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const projection = useQuietThreadProjection(threadRef)?.projection.thread;
  const items = projection?.observationItems ?? [];
  const openItems = items.filter((item) => OPEN_OBSERVATION_STATUSES.has(item.status));
  if (openItems.length === 0) return null;

  const subscriberCount = projection?.observationStreamSubscribers?.length ?? 0;

  return (
    <div className="chat-content-lane">
      <div className="border-border/60 bg-muted/30 flex flex-col gap-2 rounded-md border px-3 py-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <RadioIcon className="size-3.5" />
          Observation stream
          {subscriberCount > 0 ? (
            <span className="font-normal">· {subscriberCount} subscribed</span>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1.5">
          {openItems.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium">{item.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {statusLabel(item.status)}
                </span>
              </div>
              {item.body ? (
                <p className="text-muted-foreground line-clamp-2 text-xs">{item.body}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
