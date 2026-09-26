import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";
import type { RefObject } from "react";

import { environmentScopeLabel, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ALL_ENVIRONMENTS_VALUE, EnvironmentScopeRadioItems } from "../EnvironmentScopeRadioItems";
import { Menu, MenuPopup, MenuRadioGroup, MenuTrigger } from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

/**
 * Radio menu narrowing the sidebar to one environment. The trigger swaps to
 * the selected machine's glyph so the active scope reads without opening the
 * menu, and "All environments" heads the list so the way back is one click.
 */
export function SidebarEnvironmentScopeMenu({
  items,
  selected,
  anchor,
  onChange,
}: {
  items: readonly EnvironmentPresentation[];
  selected: EnvironmentPresentation | null;
  /** The popup anchors to the header search field, not its 28px trigger, like the folder menu. */
  anchor: RefObject<HTMLDivElement | null>;
  onChange: (environmentId: EnvironmentId | null) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              selected
                ? `Filter threads by environment: ${environmentScopeLabel(selected, items)}`
                : "Filter threads by environment"
            }
          />
        }
      >
        {selected ? (
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-4"
          />
        ) : (
          <LayersIcon className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup
        align="start"
        anchor={anchor}
        className="min-w-(--anchor-width) max-w-[min(18rem,var(--available-width))]"
      >
        <MenuRadioGroup
          value={selected?.environmentId ?? ALL_ENVIRONMENTS_VALUE}
          onValueChange={(next) => {
            onChange(items.find((item) => item.environmentId === next)?.environmentId ?? null);
          }}
        >
          <EnvironmentScopeRadioItems environments={items} />
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
