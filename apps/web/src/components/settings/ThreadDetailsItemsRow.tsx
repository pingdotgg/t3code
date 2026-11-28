import { T, useGT, Var } from "gt-react";
import { ChevronDownIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ThreadDetailsItemsMenuItems } from "../chat/ThreadDetailsItemsMenu";
import {
  isDefaultThreadDetailsOrder,
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsOrder,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function ThreadDetailsItemsRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const order = useClientSettings(resolveThreadDetailsOrder);
  const enabled = THREAD_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
  return (
    <SettingsRow
      {...searchableSetting("thread-details-items")}
      description={gt(
        "Choose what the thread details card shows. On the card, right-click for this list or drag an item to move it.",
      )}
      resetAction={
        isDefaultThreadDetailsVisibility(visibility) &&
        isDefaultThreadDetailsOrder(order) ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset thread details to default")}
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
                aria-label={gt("Thread details: {enabled} of {total} on", {
                  enabled,
                  total: THREAD_DETAILS_ITEMS.length,
                })}
              />
            }
          >
            <T>
              <Var>{enabled}</Var> of <Var>{THREAD_DETAILS_ITEMS.length}</Var> on
            </T>
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
