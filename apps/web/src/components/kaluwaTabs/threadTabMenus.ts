// Fork: the right-click menus of Kaluwa's titlebar tabs and group chips. They use the app's
// context menu, which is native on desktop and an in-page menu on the web.
import type { ContextMenuItem, ContextMenuSource } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { KALUWA_SWATCH_LABELS } from "../settings/kaluwaLookLabels";
import {
  THREAD_TAB_GROUP_COLORS,
  addThreadTabToGroup,
  createThreadTabGroup,
  moveThreadTabGroup,
  moveThreadTabToEdge,
  nextThreadTabGroupColor,
  otherThreadTabs,
  pinThreadTab,
  removeThreadTabFromGroup,
  threadTabGroupMembers,
  threadTabsToTheRight,
  ungroupThreadTabs,
  unpinThreadTab,
  unpinnedThreadTabs,
  updateThreadTabGroup,
  type ThreadTabGroup,
  type ThreadTabGroupColor,
  type ThreadTabKey,
} from "../../kaluwa/kaluwaThreadTabs.logic";
import { readLocalApi } from "../../localApi";
import {
  activateThreadTab,
  closeThreadTabsAndFollow,
  openNewThreadTab,
  readLiveThreadTabs,
  reopenClosedThreadTab,
  updateThreadTabs,
} from "./threadTabActions";

export type ThreadTabMenuContext = {
  readonly router: AnyRouter;
  readonly startRename: (
    target:
      | { readonly kind: "thread"; readonly key: ThreadTabKey }
      | {
          readonly kind: "group";
          readonly id: string;
        },
  ) => void;
};

type MenuPlacement = {
  readonly position: { readonly x: number; readonly y: number };
  readonly source: ContextMenuSource;
};

/** Fallbacks for builds that do not paint Kaluwa's palette. */
const GROUP_COLOR_FALLBACKS: Record<ThreadTabGroupColor, string> = {
  steel: "#7ea6c9",
  clay: "#d9826a",
  ochre: "#d6b36a",
  sage: "#86b49a",
  plum: "#b39ad6",
  rose: "#d9909f",
  lagoon: "#6fb3b8",
  dusk: "#8f95d6",
  ash: "#a8a29e",
};

const swatchIcons = new Map<string, string>();

/** A small round PNG of a group colour, for the native menu's colour items. */
function swatchIcon(color: ThreadTabGroupColor): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value =
    getComputedStyle(document.documentElement)
      .getPropertyValue(`--kaluwa-swatch-${color}`)
      .trim() || GROUP_COLOR_FALLBACKS[color];
  const cached = swatchIcons.get(value);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.fillStyle = value;
  context.beginPath();
  context.arc(16, 16, 12, 0, Math.PI * 2);
  context.fill();
  const url = canvas.toDataURL("image/png");
  swatchIcons.set(value, url);
  return url;
}

function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function groupLabel(group: ThreadTabGroup): string {
  return group.name.length > 0 ? group.name : m(msg("Unnamed group"));
}

type TabMenuAction =
  | "new-right"
  | "rename"
  | "thread-actions"
  | "pin"
  | "unpin"
  | "new-group"
  | "remove-group"
  | "move-start"
  | "move-end"
  | "close"
  | "close-others"
  | "close-right"
  | "close-all"
  | "reopen"
  | `group:${string}`;

/**
 * Shows a tab's menu and runs the choice. Resolves to "thread-actions" when the caller should
 * open the thread's own action menu.
 */
export async function showThreadTabMenu(
  context: ThreadTabMenuContext,
  key: ThreadTabKey,
  options: MenuPlacement & { readonly canRename: boolean },
): Promise<TabMenuAction | null> {
  const api = readLocalApi();
  if (!api) return null;
  const state = readLiveThreadTabs();
  if (!state.tabs.includes(key)) return null;
  const pinned = state.pinned.includes(key);
  const groupId = state.groupOf[key];
  const otherGroups = state.groups.filter((group) => group.id !== groupId);
  const isThread = key.startsWith("thread:");
  const items: ContextMenuItem<TabMenuAction>[] = [
    { id: "new-right", label: m(msg("New tab to the right")) },
    ...(isThread
      ? [
          {
            id: "rename" as const,
            label: m(msg("Rename thread")),
            disabled: !options.canRename,
            separatorBefore: true,
          },
          ...(key === state.active
            ? [{ id: "thread-actions" as const, label: m(msg("Thread actions…")) }]
            : []),
        ]
      : []),
    {
      id: pinned ? "unpin" : "pin",
      label: pinned ? m(msg("Unpin tab")) : m(msg("Pin tab")),
      separatorBefore: true,
    },
    { id: "new-group", label: m(msg("Add tab to new group")) },
    ...(otherGroups.length > 0
      ? [
          {
            id: "group:" as const,
            label: m(msg("Add tab to group")),
            children: otherGroups.map((group) => ({
              id: `group:${group.id}` as const,
              label: groupLabel(group),
              ...(swatchIcon(group.color) ? { iconImage: swatchIcon(group.color)! } : {}),
            })),
          },
        ]
      : []),
    ...(groupId !== undefined
      ? [{ id: "remove-group" as const, label: m(msg("Remove from group")) }]
      : []),
    { id: "move-start", label: m(msg("Move tab to start")), separatorBefore: true },
    { id: "move-end", label: m(msg("Move tab to end")) },
    { id: "close", label: m(msg("Close tab")), separatorBefore: true },
    {
      id: "close-others",
      label: m(msg("Close other tabs")),
      disabled: otherThreadTabs(state, key).length === 0,
    },
    {
      id: "close-right",
      label: m(msg("Close tabs to the right")),
      disabled: threadTabsToTheRight(state, key).length === 0,
    },
    {
      id: "close-all",
      label: m(msg("Close all tabs")),
      disabled: unpinnedThreadTabs(state).length === 0,
    },
    {
      id: "reopen",
      label: m(msg("Reopen closed tab")),
      disabled: state.closed.length === 0,
      separatorBefore: true,
    },
  ];
  const action = await api.contextMenu.show(items, options.position, options.source);
  if (action === null) return null;
  runTabMenuAction(context, key, action);
  return action;
}

function runTabMenuAction(context: ThreadTabMenuContext, key: ThreadTabKey, action: TabMenuAction) {
  const { router } = context;
  const live = readLiveThreadTabs();
  switch (action) {
    case "new-right":
      if (live.active !== key) activateThreadTab(router, key);
      void openNewThreadTab(router);
      return;
    case "rename":
      context.startRename({ kind: "thread", key });
      return;
    case "thread-actions":
      return;
    case "pin":
      updateThreadTabs((state) => pinThreadTab(state, key));
      return;
    case "unpin":
      updateThreadTabs((state) => unpinThreadTab(state, key));
      return;
    case "new-group": {
      const id = newGroupId();
      updateThreadTabs((state) =>
        createThreadTabGroup(state, [key], { id, color: nextThreadTabGroupColor(state) }),
      );
      context.startRename({ kind: "group", id });
      return;
    }
    case "remove-group":
      updateThreadTabs((state) => removeThreadTabFromGroup(state, key));
      return;
    case "move-start":
    case "move-end":
      updateThreadTabs((state) =>
        moveThreadTabToEdge(state, key, action === "move-start" ? "start" : "end"),
      );
      return;
    case "close":
      closeThreadTabsAndFollow(router, [key]);
      return;
    case "close-others":
      if (live.active !== key) activateThreadTab(router, key);
      closeThreadTabsAndFollow(router, otherThreadTabs(live, key));
      return;
    case "close-right":
      closeThreadTabsAndFollow(router, threadTabsToTheRight(live, key));
      return;
    case "close-all":
      closeThreadTabsAndFollow(router, unpinnedThreadTabs(live));
      return;
    case "reopen":
      reopenClosedThreadTab(router);
      return;
    default: {
      const groupId = action.slice("group:".length);
      if (groupId.length > 0) updateThreadTabs((state) => addThreadTabToGroup(state, key, groupId));
    }
  }
}

type GroupMenuAction =
  | "rename"
  | "toggle"
  | "new-tab"
  | "move-start"
  | "move-end"
  | "ungroup"
  | "close"
  | `color:${ThreadTabGroupColor}`
  | "color:";

/** Shows a group chip's menu and runs the choice. */
export async function showThreadTabGroupMenu(
  context: ThreadTabMenuContext,
  group: ThreadTabGroup,
  options: MenuPlacement,
): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  const items: ContextMenuItem<GroupMenuAction>[] = [
    { id: "rename", label: m(msg("Rename group")) },
    {
      id: "color:",
      label: m(msg("Group color")),
      children: THREAD_TAB_GROUP_COLORS.map((color) => ({
        id: `color:${color}` as const,
        label: m(KALUWA_SWATCH_LABELS[color]),
        checked: group.color === color,
        ...(swatchIcon(color) ? { iconImage: swatchIcon(color)! } : {}),
      })),
    },
    {
      id: "toggle",
      label: group.collapsed ? m(msg("Expand group")) : m(msg("Collapse group")),
    },
    { id: "new-tab", label: m(msg("New tab in group")), separatorBefore: true },
    { id: "move-start", label: m(msg("Move group to start")), separatorBefore: true },
    { id: "move-end", label: m(msg("Move group to end")) },
    { id: "ungroup", label: m(msg("Ungroup")), separatorBefore: true },
    { id: "close", label: m(msg("Close group")), destructive: true },
  ];
  const action = await api.contextMenu.show(items, options.position, options.source);
  if (action === null) return;
  const { router } = context;
  switch (action) {
    case "rename":
      context.startRename({ kind: "group", id: group.id });
      return;
    case "toggle":
      updateThreadTabs((state) =>
        updateThreadTabGroup(state, group.id, { collapsed: !group.collapsed }),
      );
      return;
    case "new-tab": {
      const last = threadTabGroupMembers(readLiveThreadTabs(), group.id).at(-1);
      if (last !== undefined) activateThreadTab(router, last);
      void openNewThreadTab(router);
      return;
    }
    case "move-start":
      updateThreadTabs((state) =>
        moveThreadTabGroup(
          state,
          group.id,
          state.tabs.find((tab) => !state.pinned.includes(tab)) ?? null,
          "before",
        ),
      );
      return;
    case "move-end":
      updateThreadTabs((state) => moveThreadTabGroup(state, group.id, null, "after"));
      return;
    case "ungroup":
      updateThreadTabs((state) => ungroupThreadTabs(state, group.id));
      return;
    case "close":
      closeThreadTabsAndFollow(router, threadTabGroupMembers(readLiveThreadTabs(), group.id));
      return;
    default: {
      const color = THREAD_TAB_GROUP_COLORS.find((candidate) => action === `color:${candidate}`);
      if (color) updateThreadTabs((state) => updateThreadTabGroup(state, group.id, { color }));
    }
  }
}
