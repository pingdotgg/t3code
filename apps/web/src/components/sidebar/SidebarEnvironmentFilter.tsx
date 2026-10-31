import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, ServerIcon } from "lucide-react";
import { useId, useState } from "react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Checkbox } from "../ui/checkbox";

export function SidebarEnvironmentFilter(props: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly excludedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly onChange: (excludedIds: ReadonlySet<EnvironmentId>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const selected = props.environments.filter(
    (environment) => !props.excludedEnvironmentIds.has(environment.environmentId),
  );
  const allSelected = props.excludedEnvironmentIds.size === 0;
  const label = allSelected
    ? "All environments"
    : selected.length === 0
      ? "No environments"
      : selected.length === 1
        ? selected[0]!.label
        : `${selected.length} environments`;

  return (
    <div className="shrink-0 border-t border-border/70 p-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-7 sm:text-sm"
      >
        <ServerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {expanded ? (
          <ChevronUpIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded ? (
        <div
          id={panelId}
          role="group"
          aria-label="Filter environments"
          className="max-h-[min(14rem,calc(var(--available-height)-10rem))] overflow-y-auto"
        >
          <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-base hover:bg-accent sm:min-h-7 sm:text-sm">
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && selected.length > 0}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? new Set()
                    : new Set(props.environments.map((environment) => environment.environmentId)),
                )
              }
            />
            <span>All environments</span>
          </label>
          <div className="mx-2 my-1 h-px bg-border/70" />
          {props.environments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-base hover:bg-accent sm:min-h-7 sm:text-sm"
            >
              <Checkbox
                checked={!props.excludedEnvironmentIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(props.excludedEnvironmentIds);
                  if (checked) next.delete(environment.environmentId);
                  else next.add(environment.environmentId);
                  props.onChange(next);
                }}
              />
              <EnvironmentMachineIcon
                aria-hidden
                kind={props.machineByEnvironmentId.get(environment.environmentId) ?? "server"}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{environment.label}</span>
              {environment.environmentId === props.primaryEnvironmentId ? (
                <span className="text-xs text-muted-foreground">This machine</span>
              ) : null}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
