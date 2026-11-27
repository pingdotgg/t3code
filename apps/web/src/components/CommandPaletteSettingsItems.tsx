import { useLocation, useNavigate } from "@tanstack/react-router";
import { decodeMsg, useMessages } from "gt-react";
import { SettingsIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import {
  settingsForThisPlatform,
  SETTINGS_NAV_LABELS,
  SETTINGS_SECTION_LABELS,
} from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";

const NO_SETTINGS_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];

/**
 * Every setting as a palette row, so settings get the palette's word starts and typo
 * tolerance. Its own hook so the compiler keeps the rows across keystrokes. Only a search
 * lists settings, so opening the palette does not translate them.
 */
export function useCommandPaletteSettingsItems(
  searching: boolean,
): ReadonlyArray<CommandPaletteActionItem> {
  const messages = useMessages();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  if (!searching) return NO_SETTINGS_ITEMS;
  return settingsForThisPlatform(availableSettingsSearchItems).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    // Matches the English and the displayed language, like the settings search.
    searchTerms: [
      item.title,
      SETTINGS_SECTION_LABELS[item.to],
      SETTINGS_NAV_LABELS[item.to],
      ...(item.searchTerms ?? []),
    ].flatMap((term) => [messages(term), decodeMsg(term)]),
    title: messages(item.title),
    description: messages(SETTINGS_SECTION_LABELS[item.to]),
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        search: { pane: undefined },
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
}
