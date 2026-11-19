import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MonitorSmartphoneIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import type { SidebarEnvironmentWork } from "../Sidebar.logic";
import {
  Menu,
  MenuGroupLabel,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const ALL_ENVIRONMENTS = "all";

/**
 * Narrows the sidebar to one environment. It only hides rows: connections stay as they are, and
 * the trigger keeps a dot while a hidden environment has a thread waiting on the user.
 */
export function SidebarEnvironmentScopeMenu({
  environments,
  machineByEnvironmentId,
  value,
  work,
  onValueChange,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly value: EnvironmentId | null;
  readonly work: ReadonlyMap<EnvironmentId, SidebarEnvironmentWork>;
  readonly onValueChange: (environmentId: EnvironmentId | null) => void;
}) {
  const gt = useGT();
  const selected = environments.find((environment) => environment.environmentId === value);
  const hiddenNeedsYou =
    value === null
      ? 0
      : [...work].reduce(
          (total, [environmentId, entry]) =>
            environmentId === value ? total : total + entry.needsYou,
          0,
        );
  const label = selected
    ? hiddenNeedsYou > 0
      ? gt(
          "{count, plural, one {Showing {environment}. {count} thread elsewhere needs you} other {Showing {environment}. {count} threads elsewhere need you}}",
          { environment: selected.label, count: hiddenNeedsYou },
        )
      : gt("Showing {environment}", { environment: selected.label })
    : gt("Filter threads by environment");
  const detail = (entry: SidebarEnvironmentWork | undefined) => {
    if (entry === undefined) return null;
    const parts = [
      entry.needsYou > 0
        ? gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
            count: entry.needsYou,
          })
        : null,
      entry.working > 0 ? gt("{count} working", { count: entry.working }) : null,
    ].filter((part) => part !== null);
    return parts.length === 0 ? null : <MenuItemDetail>{parts.join(" · ")}</MenuItemDetail>;
  };

  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label={label} />}>
        {selected ? (
          <EnvironmentMachineIcon
            kind={machineByEnvironmentId.get(selected.environmentId) ?? "desktop"}
            className="size-4"
          />
        ) : (
          <MonitorSmartphoneIcon className="size-4" />
        )}
        {hiddenNeedsYou > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-warning"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start" className="w-[min(18rem,var(--available-width))]">
        <MenuGroupLabel>{gt("Show threads from")}</MenuGroupLabel>
        <MenuRadioGroup
          value={value ?? ALL_ENVIRONMENTS}
          onValueChange={(next: string) =>
            onValueChange(next === ALL_ENVIRONMENTS ? null : (next as EnvironmentId))
          }
        >
          <MenuRadioItem value={ALL_ENVIRONMENTS} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <MonitorSmartphoneIcon className="size-4" aria-hidden />
              <span className="min-w-0 truncate">{gt("All environments")}</span>
            </span>
          </MenuRadioItem>
          {environments.map((environment) => (
            <MenuRadioItem
              key={environment.environmentId}
              value={environment.environmentId}
              closeOnClick
            >
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  kind={machineByEnvironmentId.get(environment.environmentId) ?? "desktop"}
                  className="size-4"
                  aria-hidden
                />
                <span className="min-w-0 truncate">{environment.label}</span>
                {detail(work.get(environment.environmentId))}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
