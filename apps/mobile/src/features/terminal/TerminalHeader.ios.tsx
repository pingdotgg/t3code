import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
} from "../../lib/appearancePreferences";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { basename, getTerminalStatusLabel } from "./terminalMenu";
import type { TerminalHeaderProps } from "./TerminalHeader.types";

export function TerminalHeader(props: TerminalHeaderProps) {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  return (
    <>
      <NativeStackScreenOptions
        options={{
          // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS — the pty
          // scrolls internally, nothing for glass to sample). Default title/subtitle
          // styling, like every other page.
          headerShown: true,
          title: "Terminal",
          unstable_headerSubtitle: props.subtitle.length > 0 ? props.subtitle : undefined,
        }}
      />

      {layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Close terminal"
            icon="xmark"
            onPress={props.onCloseTerminal}
            separateBackground
          />
          <NativeHeaderToolbar.Button
            accessibilityLabel={panes.primarySidebarVisible ? "Maximize terminal" : "Show threads"}
            icon={
              panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
            }
            onPress={togglePrimarySidebar}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}

      {props.isEnvironmentReady ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Menu icon="terminal" title="Terminal options" separateBackground>
            <NativeHeaderToolbar.Label>
              {getTerminalStatusLabel({
                status: props.status.status,
                hasRunningSubprocess: props.status.hasRunningSubprocess,
              })}
            </NativeHeaderToolbar.Label>
            <NativeHeaderToolbar.Menu icon="textformat.size" inline title="Text size">
              <NativeHeaderToolbar.Label>Text size</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                disabled={props.fontSize <= MIN_TERMINAL_FONT_SIZE}
                discoverabilityLabel="Decrease terminal text size"
                onPress={props.onDecreaseFontSize}
              >
                <NativeHeaderToolbar.Label>{`A- ${Math.max(MIN_TERMINAL_FONT_SIZE, props.fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                disabled={props.fontSize >= MAX_TERMINAL_FONT_SIZE}
                discoverabilityLabel="Increase terminal text size"
                onPress={props.onIncreaseFontSize}
              >
                <NativeHeaderToolbar.Label>{`A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, props.fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
            {props.sessions.map((session) => (
              <NativeHeaderToolbar.MenuAction
                key={session.terminalId}
                icon={session.terminalId === props.terminalId ? "checkmark" : "terminal"}
                onPress={() => props.onSelectTerminal(session.terminalId)}
                subtitle={[
                  getTerminalStatusLabel({ status: session.status }),
                  basename(session.cwd),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <NativeHeaderToolbar.Label>{session.displayLabel}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ))}
            <NativeHeaderToolbar.MenuAction
              icon="plus"
              onPress={props.onOpenNewTerminal}
              subtitle={`Start another shell in ${basename(props.workspaceRoot) ?? "this workspace"}`}
            >
              <NativeHeaderToolbar.Label>Open new terminal</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}
