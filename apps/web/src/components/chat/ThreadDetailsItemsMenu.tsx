import type { EnvironmentId } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

export function useAvailableThreadDetailsItems(environmentId?: EnvironmentId) {
  const serverConfigs = useServerConfigs();
  const isRecapEnabled = (config: ReturnType<typeof serverConfigs.get>) =>
    config?.environment.capabilities.threadRecap === true &&
    config.settings.threadRecapEnabled === true;
  const recapEnabled =
    environmentId !== undefined
      ? isRecapEnabled(serverConfigs.get(environmentId))
      : Array.from(serverConfigs.values()).some(isRecapEnabled);
  return recapEnabled
    ? THREAD_DETAILS_ITEMS
    : THREAD_DETAILS_ITEMS.filter((item) => item.id !== "recap");
}

/** Menu body that shows and hides thread details items. The card's context menu and Settings share it. */
export function ThreadDetailsItemsMenuItems({
  environmentId,
}: {
  readonly environmentId?: EnvironmentId;
} = {}) {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const items = useAvailableThreadDetailsItems(environmentId);
  const m = useMessages();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>
          <T>Show in thread details</T>
        </MenuGroupLabel>
        {items.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) =>
              updateClientSettings({
                threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
              })
            }
          >
            {m(item.label)}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultThreadDetailsVisibility(visibility)}
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        <T>Reset to default</T>
      </MenuItem>
    </>
  );
}
