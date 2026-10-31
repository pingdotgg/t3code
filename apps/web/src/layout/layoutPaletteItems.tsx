import type { LayoutKeybindingCommand } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowLeftToLineIcon,
  ArrowRightIcon,
  ArrowRightToLineIcon,
  ArrowUpIcon,
  ChevronFirstIcon,
  ChevronLastIcon,
  Columns2Icon,
  KeyboardIcon,
  LayoutGridIcon,
  Maximize2Icon,
  MoveHorizontalIcon,
  RulerIcon,
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
import {
  openLayoutBeside,
  openLayoutNewTab,
  readLayoutOpenBesideKinds,
  toggleFocusedLayoutFill,
} from "./layoutActions";
import { runLayoutCommand } from "./layoutCommands";
import { toggleLayoutShortcutSheet } from "./layoutOverlayStore";

/**
 * "Open beside…" (pen hJiZ5): what the launcher offers, opened as tabs of the
 * focused chat's pane. Typing the letter narrows to one row; ↵ opens it.
 * Null when the focused chat offers none of them.
 */
export function buildOpenBesidePaletteItem(): CommandPaletteSubmenuItem | null {
  const available = readLayoutOpenBesideKinds();
  const items = SURFACE_LAUNCHER_ENTRIES.filter((entry) => available.has(entry.kind)).map(
    (entry): CommandPaletteActionItem => ({
      kind: "action",
      value: `action:open-beside:${entry.kind}`,
      searchTerms: [entry.label.toLowerCase(), entry.shortcut.toLowerCase()],
      title: entry.label,
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
    title: "Open beside…",
    icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PanelRightIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: "open-beside", label: "Open beside", items }],
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
    title: "New pane to the right",
    icon: Columns2Icon,
    searchTerms: ["split"],
  },
  {
    command: "layout.splitDown",
    title: "New pane below",
    icon: Columns2Icon,
    searchTerms: ["split"],
  },
  {
    command: "layout.fill",
    title: "Fill the window",
    icon: Maximize2Icon,
    searchTerms: ["maximize"],
  },
  { command: "layout.focusLeft", title: "Focus pane on the left", icon: ArrowLeftIcon },
  { command: "layout.focusRight", title: "Focus pane on the right", icon: ArrowRightIcon },
  { command: "layout.focusUp", title: "Focus pane above", icon: ArrowUpIcon },
  { command: "layout.focusDown", title: "Focus pane below", icon: ArrowDownIcon },
  {
    command: "layout.moveLeft",
    title: "Move pane left",
    icon: ArrowLeftToLineIcon,
    searchTerms: ["swap"],
  },
  {
    command: "layout.moveRight",
    title: "Move pane right",
    icon: ArrowRightToLineIcon,
    searchTerms: ["swap"],
  },
  { command: "layout.moveUp", title: "Move pane up", icon: ArrowUpIcon, searchTerms: ["swap"] },
  {
    command: "layout.moveDown",
    title: "Move pane down",
    icon: ArrowDownIcon,
    searchTerms: ["swap"],
  },
  { command: "layout.focusFirstColumn", title: "Focus first column", icon: ChevronFirstIcon },
  { command: "layout.focusLastColumn", title: "Focus last column", icon: ChevronLastIcon },
  {
    command: "layout.cycleColumnWidth",
    title: "Column width ⅓ ½ ⅔",
    icon: RulerIcon,
    searchTerms: ["resize"],
  },
  { command: "layout.centerColumn", title: "Center column", icon: MoveHorizontalIcon },
  {
    command: "layout.pullLeft",
    title: "Pull pane into the left column",
    icon: ArrowLeftToLineIcon,
  },
  {
    command: "layout.pullRight",
    title: "Push pane out to its own column",
    icon: ArrowRightToLineIcon,
  },
  {
    command: "layout.overview",
    title: "Workspaces overview",
    icon: LayoutGridIcon,
    searchTerms: ["overview", "workspaces", "zoom out"],
  },
  {
    command: "layout.focusWorkspaceDown",
    title: "Focus workspace below",
    icon: ArrowDownIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.focusWorkspaceUp",
    title: "Focus workspace above",
    icon: ArrowUpIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.moveToWorkspaceDown",
    title: "Move pane to the workspace below",
    icon: ArrowDownIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.moveToWorkspaceUp",
    title: "Move pane to the workspace above",
    icon: ArrowUpIcon,
    searchTerms: ["workspace"],
  },
  {
    command: "layout.moveWorkspaceDown",
    title: "Move workspace down",
    icon: ArrowDownIcon,
    searchTerms: ["workspace", "reorder"],
  },
  {
    command: "layout.moveWorkspaceUp",
    title: "Move workspace up",
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
export function buildLayoutPaletteItems(): Array<
  CommandPaletteSubmenuItem | CommandPaletteActionItem
> {
  const items = LAYOUT_ENTRIES.map((entry): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:${entry.command}`,
    searchTerms: [entry.title.toLowerCase(), "layout", "pane", ...(entry.searchTerms ?? [])],
    title: entry.title,
    icon: <entry.icon className={ITEM_ICON_CLASS} />,
    shortcutCommand: entry.command,
    run: async () => runLayoutPaletteCommand(entry.command),
  }));
  return [
    {
      kind: "submenu",
      value: "action:layout",
      searchTerms: ["layout", "panes", "columns", "split", "focus pane", "move pane", "workspaces"],
      title: "Layout…",
      icon: <LayoutGridIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <LayoutGridIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "layout", label: "Layout", items }],
    },
    {
      kind: "action",
      value: "action:layout.shortcutSheet",
      searchTerms: ["shortcuts", "keyboard shortcuts", "keys", "layout keys"],
      title: "Show every shortcut",
      icon: <KeyboardIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "layout.shortcutSheet",
      run: async () => toggleLayoutShortcutSheet(),
    },
  ];
}
