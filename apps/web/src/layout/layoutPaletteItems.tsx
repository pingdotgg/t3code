import type { LayoutKeybindingCommand } from "@t3tools/contracts";
import { msg } from "gt-react";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowLeftToLineIcon,
  ArrowRightIcon,
  ArrowRightToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  ChevronFirstIcon,
  ChevronLastIcon,
  Columns2Icon,
  KeyboardIcon,
  LayoutGridIcon,
  Maximize2Icon,
  MoveHorizontalIcon,
  RulerIcon,
  Rows2Icon,
  PanelRightIcon,
  type LucideIcon,
} from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { SURFACE_LAUNCHER_ENTRIES } from "../components/SurfaceLauncher";
import { Kbd } from "../components/ui/kbd";
import { m, type MessageResolver } from "../i18n/messages";
import {
  openLayoutBeside,
  openLayoutNewTab,
  readLayoutOpenBesideKinds,
  toggleFocusedLayoutFill,
} from "./layoutActions";
import { isScrollingWorkspaceCommand } from "./layoutBehavior";
import { runLayoutCommand } from "./layoutCommands";
import { toggleLayoutShortcutSheet } from "./layoutOverlayStore";

/**
 * "Open beside…" (pen hJiZ5): what the launcher offers, opened as tabs of the
 * focused chat's pane. Typing the letter narrows to one row; ↵ opens it.
 * Null when the focused chat offers none of them.
 */
export function buildOpenBesidePaletteItem(
  resolve: MessageResolver = m,
): CommandPaletteSubmenuItem | null {
  const available = readLayoutOpenBesideKinds();
  const items = SURFACE_LAUNCHER_ENTRIES.filter((entry) => available.has(entry.kind)).map(
    (entry): CommandPaletteActionItem => ({
      kind: "action",
      value: `action:open-beside:${entry.kind}`,
      searchTerms: [resolve(entry.label).toLowerCase(), entry.shortcut.toLowerCase()],
      title: resolve(entry.label),
      icon: <entry.icon className={ITEM_ICON_CLASS} />,
      titleTrailingContent: <Kbd>{entry.shortcut}</Kbd>,
      run: async () => openLayoutBeside(entry.kind),
    }),
  );
  if (items.length === 0) return null;
  return {
    kind: "submenu",
    value: "action:open-beside",
    searchTerms: [
      "open beside",
      "side pane",
      "diff",
      "files",
      "browser",
      "pull request",
      "linked pull requests",
      "device",
      "terminal",
    ],
    title: resolve(msg("Open beside…")),
    icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PanelRightIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "open-beside",
        label: resolve(msg("Open beside", { $context: "verb, opens a panel next to the chat" })),
        items,
      },
    ],
  };
}

const LAYOUT_ENTRIES: ReadonlyArray<{
  command: LayoutKeybindingCommand;
  title: string;
  icon: LucideIcon;
  searchTerms?: ReadonlyArray<string>;
}> = [
  {
    command: "layout.splitRight",
    title: msg("New pane to the right"),
    icon: Columns2Icon,
    searchTerms: ["split"],
  },
  {
    command: "layout.splitDown",
    title: msg("New pane below"),
    icon: Rows2Icon,
    searchTerms: ["split"],
  },
  {
    command: "layout.fill",
    title: msg("Fill the window"),
    icon: Maximize2Icon,
    searchTerms: ["maximize"],
  },
  { command: "layout.focusLeft", title: msg("Focus pane on the left"), icon: ArrowLeftIcon },
  { command: "layout.focusRight", title: msg("Focus pane on the right"), icon: ArrowRightIcon },
  { command: "layout.focusUp", title: msg("Focus pane above"), icon: ArrowUpIcon },
  { command: "layout.focusDown", title: msg("Focus pane below"), icon: ArrowDownIcon },
  {
    command: "layout.moveLeft",
    title: msg("Move pane left"),
    icon: ArrowLeftToLineIcon,
    searchTerms: ["swap"],
  },
  {
    command: "layout.moveRight",
    title: msg("Move pane right"),
    icon: ArrowRightToLineIcon,
    searchTerms: ["swap"],
  },
  {
    command: "layout.moveUp",
    title: msg("Move pane up"),
    icon: ArrowUpToLineIcon,
    searchTerms: ["swap"],
  },
  {
    command: "layout.moveDown",
    title: msg("Move pane down"),
    icon: ArrowDownToLineIcon,
    searchTerms: ["swap"],
  },
  { command: "layout.focusFirstColumn", title: msg("Focus first column"), icon: ChevronFirstIcon },
  { command: "layout.focusLastColumn", title: msg("Focus last column"), icon: ChevronLastIcon },
  {
    command: "layout.cycleColumnWidth",
    title: msg("Column width ⅓ ½ ⅔"),
    icon: RulerIcon,
    searchTerms: ["resize"],
  },
  {
    command: "layout.centerColumn",
    title: msg("Center column", { $context: "verb, scrolls the focused column to the middle" }),
    icon: MoveHorizontalIcon,
  },
  {
    command: "layout.pullLeft",
    title: msg("Pull pane into the left column"),
    icon: ArrowLeftToLineIcon,
  },
  {
    command: "layout.pullRight",
    title: msg("Push pane out to its own column"),
    icon: ArrowRightToLineIcon,
  },
  {
    command: "layout.overview",
    title: msg("Workspaces overview"),
    icon: LayoutGridIcon,
    searchTerms: ["overview", "workspaces", "zoom out"],
  },
  {
    command: "layout.focusWorkspaceDown",
    title: msg("Focus workspace below"),
    icon: ArrowDownIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.focusWorkspaceUp",
    title: msg("Focus workspace above"),
    icon: ArrowUpIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.moveToWorkspaceDown",
    title: msg("Move pane to the workspace below"),
    icon: ArrowDownIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.moveToWorkspaceUp",
    title: msg("Move pane to the workspace above"),
    icon: ArrowUpIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.moveWorkspaceDown",
    title: msg("Move workspace down"),
    icon: ArrowDownIcon,
    searchTerms: ["workspace", "reorder"],
  },
  {
    command: "layout.moveWorkspaceUp",
    title: msg("Move workspace up"),
    icon: ArrowUpIcon,
    searchTerms: ["workspace", "reorder"],
  },
];

function runLayoutPaletteCommand(command: LayoutKeybindingCommand): void {
  if (command === "layout.splitRight") openLayoutNewTab("new-column");
  else if (command === "layout.splitDown") openLayoutNewTab("split-down");
  else if (command === "layout.fill") toggleFocusedLayoutFill();
  else runLayoutCommand(command);
}

/**
 * Every layout key as a palette command, under "Layout…", so each action
 * has a path that needs no key (the web keeps some keys for the browser).
 */
export function buildLayoutPaletteItems(
  scrollingWorkspaces: boolean,
  resolve: MessageResolver = m,
): Array<CommandPaletteSubmenuItem | CommandPaletteActionItem> {
  const items = LAYOUT_ENTRIES.filter(
    (entry) => scrollingWorkspaces || !isScrollingWorkspaceCommand(entry.command),
  ).map((entry): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:${entry.command}`,
    searchTerms: [
      resolve(entry.title).toLowerCase(),
      "layout",
      "pane",
      ...(entry.searchTerms ?? []),
    ],
    title: resolve(entry.title),
    icon: <entry.icon className={ITEM_ICON_CLASS} />,
    shortcutCommand: entry.command,
    run: async () => runLayoutPaletteCommand(entry.command),
  }));
  return [
    {
      kind: "submenu",
      value: "action:layout",
      searchTerms: ["layout", "panes", "columns", "split", "focus pane", "move pane", "workspaces"],
      title: resolve(msg("Layout…")),
      icon: <LayoutGridIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <LayoutGridIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "layout",
          label: resolve(msg("Layout", { $context: "group of pane and column commands" })),
          items,
        },
      ],
    },
    {
      kind: "action",
      value: "action:layout.shortcutSheet",
      searchTerms: ["shortcuts", "keyboard shortcuts", "keys", "layout keys"],
      title: resolve(msg("Show every shortcut")),
      icon: <KeyboardIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "layout.shortcutSheet",
      run: async () => toggleLayoutShortcutSheet(),
    },
  ];
}
