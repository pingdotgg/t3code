import {
  OPEN_OWNED_WORK_STATUSES,
  type OwnedWorkClosureReason,
  type OwnedWorkItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ClipboardListIcon } from "lucide-react";

import { useQuietThreadProjection } from "~/state/entities";

function statusLabel(status: OwnedWorkItem["status"]): string {
  switch (status) {
    case "assigned":
      return "Assigned";
    case "claimed":
      return "Claimed";
    case "in_progress":
      return "In progress";
    case "handed_off":
      return "Handed off";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

function closureLabel(reason: OwnedWorkClosureReason): string {
  switch (reason) {
    case "handed_off":
      return "handed off";
    case "denied":
      return "denied";
    case "canceled":
      return "canceled";
    case "no_follow_on":
      return "no follow-on";
    case "escalation":
      return "escalation";
    case "superseded":
      return "superseded";
  }
}

export function OwnedWorkPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const items = useQuietThreadProjection(threadRef)?.projection.thread.ownedWorkItems ?? [];
  const openItems = items.filter((item) => OPEN_OWNED_WORK_STATUSES.has(item.status));
  const closedWithReason = items.filter(
    (item) =>
      (item.status === "completed" || item.status === "cancelled") && item.closureReason !== null,
  );
  if (openItems.length === 0 && closedWithReason.length === 0) return null;

  return (
    <div className="chat-content-lane">
      <div className="border-border/60 bg-muted/30 flex flex-col gap-2 rounded-md border px-3 py-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <ClipboardListIcon className="size-3.5" />
          Owned work
        </div>
        {openItems.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {openItems.map((item) => {
              const ownerThreadId = item.claimedByThreadId ?? item.assigneeThreadId;
              return (
                <li key={item.id} className="flex flex-col gap-0.5 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{item.title}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  {ownerThreadId ? (
                    <p className="text-muted-foreground truncate text-xs">{ownerThreadId}</p>
                  ) : null}
                  {item.handoffNote ? (
                    <p className="text-muted-foreground line-clamp-2 text-xs">{item.handoffNote}</p>
                  ) : null}
                  {item.progress ? (
                    <p className="text-muted-foreground line-clamp-2 text-xs">{item.progress}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {closedWithReason.length > 0 ? (
          <ul className="border-border/50 flex flex-col gap-1 border-t pt-1.5">
            {closedWithReason.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground truncate">{item.title}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {statusLabel(item.status)} · {closureLabel(item.closureReason!)}
                    {item.closureTarget ? ` → ${item.closureTarget}` : ""}
                  </span>
                </div>
                {item.closureNote ? (
                  <p className="text-muted-foreground line-clamp-2 text-xs">{item.closureNote}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
