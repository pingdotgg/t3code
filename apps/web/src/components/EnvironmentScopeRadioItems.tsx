import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";

import { environmentScopeLabel, type EnvironmentPresentation } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { MenuRadioItem, MenuRadioItemIndicator, MenuSeparator } from "./ui/menu";

/** Radio value of the "All environments" row; every environment menu keys on it. */
export const ALL_ENVIRONMENTS_VALUE = "all";

/**
 * The rows of an environment radio menu: "All environments", then one row
 * per environment with its machine glyph, a label disambiguated against
 * `environments`, and an "Offline" suffix that never hides the row. Callers
 * wrap it in their own `MenuRadioGroup` and trigger.
 */
export function EnvironmentScopeRadioItems({
  environments,
}: {
  environments: readonly EnvironmentPresentation[];
}) {
  return (
    <>
      <MenuRadioItem value={ALL_ENVIRONMENTS_VALUE}>
        <span className="flex min-w-0 items-center gap-2">
          <LayersIcon aria-hidden className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">All environments</span>
          <MenuRadioItemIndicator />
        </span>
      </MenuRadioItem>
      <MenuSeparator />
      {environments.map((environment) => (
        <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
          <span className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5"
            />
            <span className="min-w-0 flex-1 truncate">
              {environmentScopeLabel(environment, environments)}
            </span>
            {environment.connection.phase === "connected" ? null : (
              <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
            )}
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
      ))}
    </>
  );
}
