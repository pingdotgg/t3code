import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { shouldShowThreadJumpHintsForModifiers } from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { useThreadJumpHintsVisible } from "../Sidebar.logic";

const SidebarJumpHintsContext = createContext(false);

export function SidebarJumpHints({
  keybindings,
  terminalOpen,
  children,
}: {
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  children: ReactNode;
}) {
  const modifiers = useShortcutModifierState();
  const terminalFocus = useTerminalFocus();
  const shouldShow = shouldShowThreadJumpHintsForModifiers(modifiers, keybindings, {
    platform: navigator.platform,
    context: {
      terminalFocus,
      terminalOpen,
      modelPickerOpen: isModelPickerOpen(),
      isWeb: !isElectron,
      isDesktop: isElectron,
    },
  });
  const visible = useThreadJumpHintsVisible(shouldShow);
  return <SidebarJumpHintsContext value={visible}>{children}</SidebarJumpHintsContext>;
}

export function useSidebarJumpHints() {
  return useContext(SidebarJumpHintsContext);
}
