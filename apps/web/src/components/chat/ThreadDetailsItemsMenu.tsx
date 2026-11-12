import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { useAnyAgentTeamsEnabled } from "../../hooks/useAgentTeamsEnabled";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_MENU_ITEMS,
} from "./threadDetailsItems";

/** Menu body that shows and hides thread details items. The card's context menu and Settings share it. */
export function ThreadDetailsItemsMenuItems() {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const agentTeamsEnabled = useAnyAgentTeamsEnabled();
  const menuItems = agentTeamsEnabled
    ? THREAD_DETAILS_MENU_ITEMS
    : THREAD_DETAILS_MENU_ITEMS.filter((item) => item.id !== "team");
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Show in thread details</MenuGroupLabel>
        {menuItems.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) =>
              updateClientSettings({
                threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
              })
            }
          >
            {item.label}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultThreadDetailsVisibility(visibility)}
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        Reset to default
      </MenuItem>
    </>
  );
}
