import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { BookOpenIcon, FolderIcon, LightbulbIcon, PlugIcon, SquarePenIcon } from "lucide-react";

import {
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  ITEM_ICON_CLASS,
} from "../components/CommandPalette.logic";
import { useChatMode, useStartConversation } from "./state";

const CODING_ACTIONS = [
  "action:new-thread",
  "action:triage",
  "action:link-pull-request",
  "action:open-thread-pull-requests",
  "action:open-file-picker",
  "action:search-project-contents",
  "action:new-project",
  "action:add-project",
  "action:pull-requests",
  "action:issues",
  "action:workflows",
  "action:project-",
  "action:port-forwards",
  "find-in-browser-page",
];

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

/** In chat mode: the app's own screens first, and no coding actions. */
export function useChatModePaletteItems(items: ReadonlyArray<PaletteItem>): Array<PaletteItem> {
  const gt = useGT();
  const navigate = useNavigate();
  const chatMode = useChatMode();
  const startConversation = useStartConversation();
  if (!chatMode) return [...items];
  const screens = [
    { to: "/workstreams", title: gt("Open projects"), Icon: FolderIcon },
    { to: "/study", title: gt("Open study"), Icon: BookOpenIcon },
    { to: "/plugins", title: gt("Open plugins"), Icon: PlugIcon },
    { to: "/memory", title: gt("Open memory"), Icon: LightbulbIcon },
  ] as const;
  return [
    {
      kind: "action",
      value: "action:new-conversation",
      searchTerms: ["new conversation", "chat"],
      title: gt("New conversation"),
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.new",
      run: async () => {
        await startConversation();
      },
    },
    ...screens.map(({ to, title, Icon }): PaletteItem => ({
      kind: "action",
      value: `action:open-${to.slice(1)}`,
      searchTerms: [to.slice(1), title],
      title,
      icon: <Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to });
      },
    })),
    ...items.filter((item) => !CODING_ACTIONS.some((action) => item.value.startsWith(action))),
  ];
}
