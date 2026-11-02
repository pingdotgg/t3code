import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { ServerIcon } from "lucide-react";

import { useEnvironmentConnectionSummaries } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const ALL_ENVIRONMENTS = "all";

export function SidebarEnvironmentScopeMenu(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly onChange: (environmentId: EnvironmentId | null) => void;
}) {
  const displayUrlById = new Map(
    useEnvironmentConnectionSummaries().map(
      (summary) => [summary.environmentId, summary.displayUrl] as const,
    ),
  );
  // Machines often share a name, so a shared label also shows the address.
  const labelFor = (environment: (typeof props.environments)[number]) => {
    const shared = props.environments.some(
      (other) =>
        other.environmentId !== environment.environmentId && other.label === environment.label,
    );
    const displayUrl = displayUrlById.get(environment.environmentId);
    return shared && displayUrl ? `${environment.label} · ${displayUrl}` : environment.label;
  };
  const selected = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              selected
                ? `Filter threads by environment: ${labelFor(selected)}`
                : "Filter threads by environment"
            }
          />
        }
      >
        {selected ? (
          <EnvironmentMachineIcon
            kind={props.machineByEnvironmentId.get(selected.environmentId) ?? "server"}
            className="size-4"
          />
        ) : (
          <ServerIcon className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={props.selectedEnvironmentId ?? ALL_ENVIRONMENTS}
          onValueChange={(value: string) =>
            props.onChange(
              props.environments.find((environment) => environment.environmentId === value)
                ?.environmentId ?? null,
            )
          }
        >
          <MenuRadioItem value={ALL_ENVIRONMENTS} closeOnClick>
            All environments
          </MenuRadioItem>
          {props.environments.map((environment) => (
            <MenuRadioItem
              key={environment.environmentId}
              value={environment.environmentId}
              closeOnClick
            >
              {labelFor(environment)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
