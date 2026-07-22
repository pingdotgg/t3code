import { useAtomValue } from "@effect/atom-react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffectEvent, useLayoutEffect } from "react";

import { createEmacsReadlineKeydownHandler } from "../emacsReadlineBindings";
import { useClientSettings } from "../hooks/useSettings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveCustomShortcutCommand, type ShortcutMatchOptions } from "../keybindings";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import type { AppRouter } from "../router";

export function getActiveShortcutMatchOptions(router: AppRouter): ShortcutMatchOptions {
  const matches = router.state.matches;
  const routeParams = matches[matches.length - 1]?.params ?? {};
  const threadRef = resolveThreadRouteRef(routeParams);
  const terminalOpen = selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  ).terminalOpen;
  const previewOpen =
    selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview";

  return {
    context: {
      terminalFocus: isTerminalFocused(),
      terminalOpen,
      previewFocus: isPreviewFocused(),
      previewOpen,
    },
  };
}

export function shouldYieldToCustomApplicationShortcut(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
  options: ShortcutMatchOptions,
): boolean {
  return resolveCustomShortcutCommand(event, keybindings, options) !== null;
}

export function EmacsReadlineBindings({ router }: { readonly router: AppRouter }) {
  const enabled = useClientSettings((settings) => settings.keyboardEditingMode === "emacs");
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return;
    createEmacsReadlineKeydownHandler({
      shouldYieldToApplicationShortcut: (candidate) =>
        shouldYieldToCustomApplicationShortcut(
          candidate,
          keybindings,
          getActiveShortcutMatchOptions(router),
        ),
    })(event);
  });

  useLayoutEffect(() => {
    // Register once so settings hydration cannot move this capture listener
    // behind application shortcut handlers.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return null;
}
