// Fork: command palette actions for Kaluwa's titlebar tabs, listed while tabs are on.
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, XIcon } from "lucide-react";

import { useKaluwaTabsSettings } from "../../kaluwa/kaluwaTabsSettings";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  activateRelativeThreadTab,
  closeActiveThreadTab,
  openNewThreadTab,
} from "./threadTabActions";

export function useKaluwaThreadTabPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const router = useRouter();
  const { enabled } = useKaluwaTabsSettings();
  if (!enabled) return [];
  return [
    {
      kind: "action",
      value: "action:kaluwa-tab-new",
      searchTerms: ["tab", "new tab", "open tab", "thread"],
      title: gt("New tab"),
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "threadTab.new",
      run: () => openNewThreadTab(router),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-close",
      searchTerms: ["tab", "close tab", "close"],
      title: gt("Close tab"),
      icon: <XIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "threadTab.close",
      run: async () => closeActiveThreadTab(router),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-next",
      searchTerms: ["tab", "next tab", "switch"],
      title: gt("Next tab"),
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "threadTab.next",
      run: async () => activateRelativeThreadTab(router, 1),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-previous",
      searchTerms: ["tab", "previous tab", "switch"],
      title: gt("Previous tab"),
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "threadTab.previous",
      run: async () => activateRelativeThreadTab(router, -1),
    },
  ];
}
