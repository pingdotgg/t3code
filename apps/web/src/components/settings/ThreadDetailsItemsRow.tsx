import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { ChevronDownIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ThreadDetailsItemsMenuItems } from "../chat/ThreadDetailsItemsMenu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ThreadDetailsItemsRow() {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const enabled = THREAD_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
  return (
    <SettingsRow
      {...searchableSetting("thread-details-items")}
      description="Choose what the thread details card shows. You can also right-click the card."
      resetAction={
        isDefaultThreadDetailsVisibility(visibility) ? null : (
          <SettingResetButton
            label="thread details"
            onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
          />
        )
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-40"
                aria-label={`Thread details: ${enabled} of ${THREAD_DETAILS_ITEMS.length} on`}
              />
            }
          >
            {enabled} of {THREAD_DETAILS_ITEMS.length} on
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <ThreadDetailsItemsMenuItems />
          </MenuPopup>
        </Menu>
      }
    />
  );
}

export function ThreadDetailsInSidebarRow() {
  const inSidebar = useClientSettings((settings) => settings.threadDetailsInSidebar);
  return (
    <SettingsRow
      {...searchableSetting("thread-details-in-sidebar")}
      devicePreference
      description="Show thread details under the open thread in the sidebar instead of over the chat. They move back to the chat while the sidebar is hidden."
      resetAction={
        inSidebar === DEFAULT_UNIFIED_SETTINGS.threadDetailsInSidebar ? null : (
          <SettingResetButton
            label="thread details placement"
            onClick={() =>
              updateClientSettings({
                threadDetailsInSidebar: DEFAULT_UNIFIED_SETTINGS.threadDetailsInSidebar,
              })
            }
          />
        )
      }
      control={
        <Switch
          checked={inSidebar}
          onCheckedChange={(checked) =>
            updateClientSettings({ threadDetailsInSidebar: Boolean(checked) })
          }
          aria-label="Show thread details in the sidebar"
        />
      }
    />
  );
}
