import { LayersIcon } from "lucide-react";

import type { EnvironmentScopeOption } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { MenuRadioItem, MenuRadioItemIndicator, MenuSeparator } from "./ui/menu";

/**
 * Radio value of the "All environments" row; every environment menu keys on it.
 * It is empty because `EnvironmentId` is non-empty. Ids arrive from remote
 * servers, so any word could be one, but no environment can claim "".
 */
export const ALL_ENVIRONMENTS_VALUE = "";

/**
 * The rows of an environment radio menu: "All environments" (unless the menu
 * must name exactly one environment), then one row per option with its machine
 * glyph, label, and an "Offline" suffix that never hides the row. Callers wrap
 * it in their own `MenuRadioGroup` and trigger.
 */
export function EnvironmentScopeRadioItems({
  options,
  includeAllEnvironments,
  closeOnClick,
}: {
  options: readonly EnvironmentScopeOption[];
  includeAllEnvironments: boolean;
  closeOnClick?: boolean;
}) {
  return (
    <>
      {includeAllEnvironments ? (
        <>
          <MenuRadioItem value={ALL_ENVIRONMENTS_VALUE} closeOnClick={closeOnClick}>
            <span className="flex min-w-0 items-center gap-2">
              <LayersIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">All environments</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          <MenuSeparator />
        </>
      ) : null}
      {options.map((option) => (
        <MenuRadioItem
          key={option.environmentId}
          value={option.environmentId}
          closeOnClick={closeOnClick}
        >
          <span className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon aria-hidden kind={option.machine} className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.offline ? (
              <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
            ) : null}
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
      ))}
    </>
  );
}
