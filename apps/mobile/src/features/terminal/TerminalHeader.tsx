import { ScreenHeader } from "../../components/ScreenHeader";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
} from "../../lib/appearancePreferences";
import { basename, getTerminalStatusLabel } from "./terminalMenu";
import type { TerminalHeaderProps } from "./TerminalHeader.types";

export function TerminalHeader(props: TerminalHeaderProps) {
  return (
    <ScreenHeader
      title="Terminal"
      subtitle={props.subtitle}
      onBack={props.onCloseTerminal}
      backInSplitView={{
        accessibilityLabel: "Close terminal",
        icon: "xmark",
        separateBackground: true,
      }}
      menus={
        props.isEnvironmentReady
          ? [
              {
                title: "Terminal options",
                icon: "terminal",
                status: getTerminalStatusLabel(props.status),
                items: [
                  {
                    id: "text-size",
                    title: "Text size",
                    icon: "textformat.size",
                    inline: true,
                    items: [
                      {
                        id: "font-decrease",
                        title: `A- ${Math.max(MIN_TERMINAL_FONT_SIZE, props.fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
                        disabled: props.fontSize <= MIN_TERMINAL_FONT_SIZE,
                        onPress: props.onDecreaseFontSize,
                      },
                      {
                        id: "font-increase",
                        title: `A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, props.fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
                        disabled: props.fontSize >= MAX_TERMINAL_FONT_SIZE,
                        onPress: props.onIncreaseFontSize,
                      },
                    ],
                  },
                  ...props.sessions.map((session) => ({
                    id: `terminal-session:${session.terminalId}`,
                    title: session.displayLabel,
                    icon: "terminal",
                    subtitle: [
                      getTerminalStatusLabel({
                        status: session.status,
                        hasRunningSubprocess: session.hasRunningSubprocess,
                      }),
                      basename(session.cwd),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    selected: session.terminalId === props.terminalId,
                    onPress: () => props.onSelectTerminal(session.terminalId),
                  })),
                  {
                    id: "terminal-new",
                    title: "Open new terminal",
                    icon: "plus",
                    subtitle: `Start another shell in ${basename(props.workspaceRoot) ?? "this workspace"}`,
                    onPress: props.onOpenNewTerminal,
                  },
                ],
              },
            ]
          : undefined
      }
    />
  );
}
