import type { MenuAction } from "@react-native-menu/menu";
import { useMemo, useCallback } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
} from "../../lib/appearancePreferences";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { basename, getTerminalStatusLabel } from "./terminalMenu";
import type { TerminalHeaderProps } from "./TerminalHeader.types";

export function TerminalHeader(props: TerminalHeaderProps) {
  const {
    fontSize,
    workspaceRoot,
    terminalId,
    sessions,
    onDecreaseFontSize,
    onIncreaseFontSize,
    onOpenNewTerminal,
    onSelectTerminal,
  } = props;
  const androidTerminalMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "text-size",
        title: "Text size",
        subactions: [
          {
            id: "font-decrease",
            title: `A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
            attributes: fontSize <= MIN_TERMINAL_FONT_SIZE ? { disabled: true } : undefined,
          },
          {
            id: "font-increase",
            title: `A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
            attributes: fontSize >= MAX_TERMINAL_FONT_SIZE ? { disabled: true } : undefined,
          },
        ],
      },
      ...sessions.map((session): MenuAction => ({
        id: `terminal-session:${session.terminalId}`,
        title: session.displayLabel,
        subtitle: [getTerminalStatusLabel({ status: session.status }), basename(session.cwd)]
          .filter(Boolean)
          .join(" · "),
        state: session.terminalId === terminalId ? ("on" as const) : undefined,
      })),
      {
        id: "terminal-new",
        title: "Open new terminal",
        image: "plus",
        subtitle: `Start another shell in ${basename(workspaceRoot) ?? "this workspace"}`,
      },
    ],
    [fontSize, workspaceRoot, terminalId, sessions],
  );

  const handleAndroidTerminalMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "font-decrease") {
        onDecreaseFontSize();
        return;
      }
      if (id === "font-increase") {
        onIncreaseFontSize();
        return;
      }
      if (id === "terminal-new") {
        onOpenNewTerminal();
        return;
      }
      if (id.startsWith("terminal-session:")) {
        onSelectTerminal(id.slice("terminal-session:".length));
      }
    },
    [onDecreaseFontSize, onIncreaseFontSize, onOpenNewTerminal, onSelectTerminal],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false, title: "Terminal" }} />
      <AndroidScreenHeader
        title="Terminal"
        subtitle={props.subtitle}
        leading={<AndroidWorkspaceSidebarButton />}
        onBack={props.onCloseTerminal}
        trailing={
          <>
            {props.isEnvironmentReady ? (
              <ControlPillMenu
                actions={androidTerminalMenuActions}
                isAnchoredToRight
                title={getTerminalStatusLabel({
                  status: props.status.status,
                  hasRunningSubprocess: props.status.hasRunningSubprocess,
                })}
                onPressAction={handleAndroidTerminalMenuAction}
              >
                <AndroidHeaderIconButton accessibilityLabel="Terminal options" icon="terminal" />
              </ControlPillMenu>
            ) : null}
          </>
        }
      />
    </>
  );
}
