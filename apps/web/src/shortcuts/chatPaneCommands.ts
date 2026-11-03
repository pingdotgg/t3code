import type { AnyRouter } from "@tanstack/react-router";

import { isChatSplitOpen, useChatPanesStore } from "../chatPanesStore";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { createChatPaneCommands } from "../hooks/useChatPaneCommands";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { type CommandHandler, registerCommands } from "./dispatcher";

const CHAT_ROUTE_ID = "/_chat";

/** Split pane shortcuts, live while a thread is routed and no modal page covers it. */
export function installChatPaneCommands(router: AnyRouter): () => void {
  const commands = createChatPaneCommands(router);
  const run =
    (action: () => void): CommandHandler =>
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
  return registerCommands(
    {
      "splitPanes.toggle": run(() => {
        if (isChatSplitOpen(useChatPanesStore.getState().layout)) commands.closeOtherPanes();
        else openCommandPalette({ open: "open-in-split" });
      }),
      "splitPanes.close": run(commands.closeFocusedPane),
      "splitPanes.swap": run(() => useChatPanesStore.getState().swap()),
      "splitPanes.toggleDirection": run(() => {
        const { layout, setDirection } = useChatPanesStore.getState();
        setDirection(layout.direction === "row" ? "column" : "row");
      }),
      "splitPanes.focusNext": run(commands.focusNextPane),
      "splitPanes.focusPrevious": run(commands.focusPreviousPane),
    },
    {
      when: () =>
        router.state.matches.some((match) => match.routeId === CHAT_ROUTE_ID) &&
        !router.state.matches.some((match) => isAppModalPage(match.pathname)) &&
        resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {}) !== null &&
        !isCommandPaletteOpen(),
      context: () => ({ splitPanesOpen: isChatSplitOpen(useChatPanesStore.getState().layout) }),
    },
  );
}
