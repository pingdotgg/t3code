import { T, useGT, Var } from "gt-react";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ThreadDetailsItemsMenuItems } from "../chat/ThreadDetailsItemsMenu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { SelectButton } from "../ui/select";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function ThreadDetailsItemsRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const enabled = THREAD_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
  return (
    <SettingsRow
      {...searchableSetting("thread-details-items")}
      description={gt(
        "Choose what the thread details card shows. You can also right-click the card.",
      )}
      resetAction={
        isDefaultThreadDetailsVisibility(visibility) ? null : (
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
              <SelectButton
                variant="well"
                size="sm"
                className="w-full @min-[26rem]/settings-row:w-40"
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
          </MenuTrigger>
          <MenuPopup align="end">
            <ThreadDetailsItemsMenuItems />
          </MenuPopup>
        </Menu>
      }
    />
  );
}
