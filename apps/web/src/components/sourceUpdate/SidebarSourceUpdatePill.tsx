import { T, useMessages } from "gt-react";
import { CircleAlertIcon, CircleArrowUpIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { sourceUpdatePillLabel } from "./sourceUpdate.logic";
import { SourceUpdateButton, SourceUpdateStatus } from "./SourceUpdateAction";
import { useSourceUpdateActions, useSourceUpdateMachines } from "./useSourceUpdate";

/** Source updates for every connected environment that runs from a git checkout. */
export function SidebarSourceUpdatePill() {
  const machines = useSourceUpdateMachines();
  const { update } = useSourceUpdateActions();
  const messages = useMessages();
  const label = sourceUpdatePillLabel(machines, messages);
  if (label === null) return null;
  const failed = machines.some(({ phase }) => phase.kind === "failed");
  const updatable = machines.filter(({ canUpdate }) => canUpdate);
  const updateAll = async () => {
    // One at a time: each may ask to confirm restarting over running turns.
    for (const { environmentId } of updatable) await update(environmentId);
  };

  return (
    <SidebarMenuItem className="ml-auto flex min-w-0 flex-1">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-full bg-sidebar-control-surface px-3 text-sidebar-foreground text-xs outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset",
                failed && "ring-1 ring-destructive/40 ring-inset",
              )}
            />
          }
        >
          {failed ? (
            <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
          ) : (
            <CircleArrowUpIcon className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        </PopoverTrigger>
        <PopoverPopup side="top" align="end" padding="compact" width="sm">
          <div className="flex flex-col gap-2 text-xs">
            {machines.map(({ environmentId, label: machineLabel }) => (
              <div key={environmentId} className="flex min-w-0 items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{machineLabel}</span>
                  <span className="break-words text-muted-foreground">
                    <SourceUpdateStatus environmentId={environmentId} />
                  </span>
                </div>
                <SourceUpdateButton environmentId={environmentId} />
              </div>
            ))}
            {updatable.length >= 2 ? (
              <div className="flex justify-end">
                <Button size="xs" variant="outline" onClick={() => void updateAll()}>
                  <T>Update all</T>
                </Button>
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
