// Fork: command palette actions for Kaluwa's titlebar tabs, listed while tabs are on.
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GroupIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";

import { useKaluwaTabsSettings } from "../../kaluwa/kaluwaTabsSettings";
import {
  createThreadTabGroup,
  nextThreadTabGroupColor,
  otherThreadTabs,
  pinThreadTab,
  threadTabsToTheRight,
  unpinThreadTab,
} from "../../kaluwa/kaluwaThreadTabs.logic";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  activateRelativeThreadTab,
  closeActiveThreadTab,
  closeThreadTabsAndFollow,
  openNewThreadTab,
  readLiveThreadTabs,
  reopenClosedThreadTab,
  updateThreadTabs,
  useLiveThreadTabs,
} from "./threadTabActions";

export function useKaluwaThreadTabPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const router = useRouter();
  const { enabled } = useKaluwaTabsSettings();
  const live = useLiveThreadTabs();
  if (!enabled) return [];
  const active = live.active;
  const activePinned = active !== null && live.pinned.includes(active);
  const withActive =
    (action: (key: string) => void): (() => Promise<void>) =>
    async () => {
      const key = readLiveThreadTabs().active;
      if (key !== null) action(key);
    };
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
      value: "action:kaluwa-tab-reopen",
      searchTerms: ["tab", "reopen", "restore", "undo close", "closed tab"],
      title: gt("Reopen closed tab"),
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "threadTab.reopen",
      disabled: live.closed.length === 0,
      run: async () => reopenClosedThreadTab(router),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-close-others",
      searchTerms: ["tab", "close other tabs", "close others"],
      title: gt("Close other tabs"),
      icon: <XIcon className={ITEM_ICON_CLASS} />,
      disabled: active === null || otherThreadTabs(live, active).length === 0,
      run: withActive((key) =>
        closeThreadTabsAndFollow(router, otherThreadTabs(readLiveThreadTabs(), key)),
      ),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-close-right",
      searchTerms: ["tab", "close tabs to the right", "close right"],
      title: gt("Close tabs to the right"),
      icon: <XIcon className={ITEM_ICON_CLASS} />,
      disabled: active === null || threadTabsToTheRight(live, active).length === 0,
      run: withActive((key) =>
        closeThreadTabsAndFollow(router, threadTabsToTheRight(readLiveThreadTabs(), key)),
      ),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-pin",
      searchTerms: ["tab", "pin tab", "unpin tab", "pin"],
      title: activePinned ? gt("Unpin tab") : gt("Pin tab"),
      icon: activePinned ? (
        <PinOffIcon className={ITEM_ICON_CLASS} />
      ) : (
        <PinIcon className={ITEM_ICON_CLASS} />
      ),
      disabled: active === null,
      run: withActive((key) =>
        updateThreadTabs((state) =>
          state.pinned.includes(key) ? unpinThreadTab(state, key) : pinThreadTab(state, key),
        ),
      ),
    },
    {
      kind: "action",
      value: "action:kaluwa-tab-group",
      searchTerms: ["tab", "group", "new tab group", "add tab to group"],
      title: gt("New tab group"),
      icon: <GroupIcon className={ITEM_ICON_CLASS} />,
      disabled: active === null,
      run: withActive((key) =>
        updateThreadTabs((state) =>
          createThreadTabGroup(state, [key], {
            id: `g${Date.now().toString(36)}`,
            color: nextThreadTabGroupColor(state),
          }),
        ),
      ),
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
