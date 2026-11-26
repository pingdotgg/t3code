import type { ContextMenuItem, KeybindingCommand, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArchiveIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HashIcon,
  type LucideIcon,
  MailOpenIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  TimerIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useGT } from "gt-react";

import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useThreadMapChosen, useThreadMapViewStore } from "../threadMapViewStore";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import type { ThreadActionMenuId } from "./threadActionMenu.logic";

const ICONS: Record<string, LucideIcon> = {
  archive: ArchiveIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  copy: CopyIcon,
  folder: FolderIcon,
  "folder-plus": FolderPlusIcon,
  "git-branch": GitBranchIcon,
  hash: HashIcon,
  "mail-open": MailOpenIcon,
  "message-square": MessageSquareIcon,
  "message-square-plus": MessageSquarePlusIcon,
  pin: PinIcon,
  "pin-off": PinOffIcon,
  "refresh-cw": RefreshCwIcon,
  timer: TimerIcon,
  trash: Trash2Icon,
};

// The palette has its own rows for these, and no inline title editor for rename.
const SKIPPED: ReadonlySet<ThreadActionMenuId> = new Set(["rename", "project-settings"]);

const SHORTCUTS: Partial<Record<ThreadActionMenuId, KeybindingCommand>> = {
  settle: "thread.settle",
  unsettle: "thread.settle",
  pin: "thread.pin",
  unpin: "thread.pin",
  "regenerate-title": "thread.regenerateTitle",
};

/** The open thread's menu actions (settle, pin, snooze, archive...) as palette rows. */
export function useCommandPaletteThreadActions(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const gt = useGT();
  const { readMenu } = useThreadActionMenu({ ...input, canShareWithGuest: false });
  const mapChosen = useThreadMapChosen(input.threadRef);
  const setThreadMapShown = useThreadMapViewStore((state) => state.setThreadMapShown);
  const menu = readMenu();
  const { threadRef } = input;
  if (!menu || threadRef === null) return [];

  const toPaletteItem = (
    item: ContextMenuItem<ThreadActionMenuId>,
  ): CommandPaletteActionItem | CommandPaletteSubmenuItem | null => {
    if (SKIPPED.has(item.id)) return null;
    const Icon = item.icon ? ICONS[item.icon] : undefined;
    const shared = {
      value: `thread-action:${item.id}`,
      searchTerms: [],
      title: item.label,
      icon: Icon ? <Icon className={ITEM_ICON_CLASS} /> : null,
      ...(item.detail ? { description: item.detail } : {}),
      ...(item.disabled ? { disabled: true } : {}),
    };
    if (item.children) {
      // Palette search lists children directly, so they inherit the parent's disabled state.
      const children = item.children.flatMap(
        (child) => toPaletteItem(item.disabled ? { ...child, disabled: true } : child) ?? [],
      );
      if (children.length === 0) return null;
      return {
        ...shared,
        kind: "submenu",
        addonIcon: Icon ? <Icon className={ADDON_ICON_CLASS} /> : null,
        groups: [{ value: shared.value, label: item.label, items: children }],
      };
    }
    const shortcutCommand = SHORTCUTS[item.id];
    return {
      ...shared,
      kind: "action",
      ...(shortcutCommand ? { shortcutCommand } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      run: () => menu.run(item.id),
    };
  };

  return [
    ...menu.items.flatMap((item) => toPaletteItem(item) ?? []),
    {
      kind: "action",
      value: "thread-action:map",
      searchTerms: ["map", "conversation", "view"],
      title: mapChosen ? gt("Show conversation") : gt("Show thread map"),
      icon: <WorkflowIcon className={ITEM_ICON_CLASS} />,
      run: async () => setThreadMapShown(threadRef, !mapChosen),
    },
  ];
}
