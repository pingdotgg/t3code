import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { TerminalContextSheet } from "./TerminalContextSheet";
import { hasNativeTerminalSurface } from "./nativeTerminalModule";
import * as Clipboard from "expo-clipboard";
import * as Schema from "effect/Schema";
import { KeyboardController, KeyboardStickyView } from "react-native-keyboard-controller";

import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { EmptyState } from "../../components/ui/EmptyState";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAttachedTerminalSession } from "../../state/use-terminal-session";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { TerminalSurface, type TerminalSurfaceHandle } from "./NativeTerminalSurface";
import { getMobileTerminalTheme } from "./terminalTheme";
import { useInitialTerminalLaunchLocation } from "./terminalLaunchContext";
import { resolveTerminalSessionLabel, type TerminalMenuSession } from "./terminalMenu";
import { type PendingModifier } from "./terminalInput";
import { TerminalHeader } from "./ThreadTerminalRouteScreenParts";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { RefObject } from "react";
import type {
  TerminalToolbarAction,
  ThreadSelection,
  useTerminalAccess,
} from "./ThreadTerminalRouteScreen";
export const TERMINAL_ACCESSORY_HEIGHT = 52;

export interface ThreadTerminalRouteScreenBodyProps {
  readonly capturedOutput: string | null;
  readonly setCapturedOutput: (value: string | null) => void;
  readonly canOperateTerminal: boolean;
  readonly canReadTerminal: boolean;
  readonly environment: ReturnType<typeof useEnvironmentPresentation>;
  readonly fontSize: number;
  readonly handleCloseTerminal: () => void;
  readonly handleDecreaseFontSize: () => void;
  readonly handleDismissKeyboard: () => void;
  readonly handleIncreaseFontSize: () => void;
  readonly handleInput: (data: string) => void;
  readonly handleOpenNewTerminal: () => void;
  readonly handleResize: (size: { readonly cols: number; readonly rows: number }) => void;
  readonly handleRetryEnvironment: () => void;
  readonly handleSelectTerminal: (nextTerminalId: string) => void;
  readonly handleShowKeyboard: () => void;
  readonly handleToolbarActionPress: (action: TerminalToolbarAction) => void;
  readonly hasTerminalTarget: boolean;
  readonly headerSubtitle: string;
  readonly insets: EdgeInsets;
  readonly isAccessoryVisible: boolean;
  readonly isEnvironmentReady: boolean;
  readonly isRunning: boolean;
  readonly keyboardState: { readonly isVisible: boolean };
  readonly keyboardFocusRequest: number;
  readonly captureRequest: number;
  readonly setCaptureRequest: (value: number) => void;
  readonly pendingModifier: PendingModifier | null;
  readonly launchLocation: ReturnType<typeof useInitialTerminalLaunchLocation>;
  readonly nativeColumnMetrics: ReturnType<typeof useNativeColumnLayoutMetrics>;
  readonly navigation: { readonly canGoBack: () => boolean; readonly goBack: () => void };
  readonly requestCapture: () => void;
  readonly selectedEnvironmentConnection: ThreadSelection["selectedEnvironmentConnection"];
  readonly selectedThread: NonNullable<ThreadSelection["selectedThread"]>;
  readonly selectedThreadProject: NonNullable<ThreadSelection["selectedThreadProject"]>;
  readonly sessionsError: string | null;
  readonly sessionsPending: boolean;
  readonly surfaceRef: RefObject<TerminalSurfaceHandle | null>;
  readonly terminal: ReturnType<typeof useAttachedTerminalSession>;
  readonly terminalAutoFocus: boolean;
  readonly terminalBottomInset: number;
  readonly terminalId: string;
  readonly terminalKey: string;
  readonly terminalMenuSessions: ReadonlyArray<TerminalMenuSession>;
  readonly terminalSession: ReturnType<typeof useTerminalAccess>["session"];
  readonly terminalTheme: ReturnType<typeof getMobileTerminalTheme>;
  readonly terminalToolbarActions: ReadonlyArray<TerminalToolbarAction>;
  readonly themeVariables: Record<string, string>;
}

export function ThreadTerminalRouteScreenBody(props: ThreadTerminalRouteScreenBodyProps) {
  const {
    capturedOutput,
    setCapturedOutput,
    canOperateTerminal,
    canReadTerminal,
    environment,
    fontSize,
    handleCloseTerminal,
    handleDecreaseFontSize,
    handleDismissKeyboard,
    handleIncreaseFontSize,
    handleInput,
    handleOpenNewTerminal,
    handleResize,
    handleRetryEnvironment,
    handleSelectTerminal,
    handleShowKeyboard,
    handleToolbarActionPress,
    hasTerminalTarget,
    headerSubtitle,
    insets,
    isAccessoryVisible,
    isEnvironmentReady,
    isRunning,
    keyboardState,
    keyboardFocusRequest,
    captureRequest,
    setCaptureRequest,
    pendingModifier,
    launchLocation,
    nativeColumnMetrics,
    navigation,
    requestCapture,
    selectedEnvironmentConnection,
    selectedThread,
    selectedThreadProject,
    sessionsError,
    sessionsPending,
    surfaceRef,
    terminal,
    terminalAutoFocus,
    terminalBottomInset,
    terminalId,
    terminalKey,
    terminalMenuSessions,
    terminalSession,
    terminalTheme,
    terminalToolbarActions,
    themeVariables,
  } = props;
  return (
    <>
      {capturedOutput !== null ? (
        <TerminalContextSheet
          text={capturedOutput}
          environmentId={selectedThread.environmentId}
          threadId={selectedThread.id}
          terminalId={terminalId}
          terminalLabel={resolveTerminalSessionLabel(terminalId, terminal.summary)}
          onClose={() => setCapturedOutput(null)}
          onAttach={() => {
            setCapturedOutput(null);
            if (navigation.canGoBack()) navigation.goBack();
          }}
        />
      ) : null}
      <TerminalHeader
        canOperateTerminal={canOperateTerminal}
        subtitle={headerSubtitle}
        isEnvironmentReady={isEnvironmentReady}
        fontSize={fontSize}
        terminalId={terminalId}
        sessions={terminalMenuSessions}
        status={{
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
        }}
        workspaceRoot={selectedThreadProject.workspaceRoot}
        onCloseTerminal={handleCloseTerminal}
        onDecreaseFontSize={handleDecreaseFontSize}
        onIncreaseFontSize={handleIncreaseFontSize}
        onOpenNewTerminal={handleOpenNewTerminal}
        onSelectTerminal={handleSelectTerminal}
      />

      <ScreenContent>
        <View
          className="flex-1"
          style={{
            backgroundColor:
              Platform.OS === "android"
                ? themeVariables["--color-card-alt"]
                : terminalTheme.background,
            // Measured top reservation is zero when UIKit already inset the body or moved the bar.
            paddingTop:
              Platform.OS === "ios" ? (nativeColumnMetrics?.safeArea.top ?? insets.top) : 0,
            paddingBottom:
              Platform.OS === "android" && !keyboardState.isVisible ? insets.bottom : 0,
          }}
        >
          {!isEnvironmentReady ? (
            <EnvironmentConnectionNotice
              environmentLabel={
                environment.presentation?.entry.target.label ??
                selectedEnvironmentConnection?.environmentLabel ??
                "Environment"
              }
              connection={
                environment.presentation?.connection ?? {
                  phase: "available",
                  error: null,
                  traceId: null,
                }
              }
              resourceName="terminal"
              onRetry={handleRetryEnvironment}
            />
          ) : terminalSession.data === null && terminalSession.error === null ? (
            <EmptyState
              title="Checking terminal access"
              detail="Waiting for this connection's permissions."
            />
          ) : !canReadTerminal && !canOperateTerminal ? (
            <EmptyState
              title={
                terminalSession.error
                  ? "Could not check terminal access"
                  : "Terminal access unavailable"
              }
              detail={
                terminalSession.error ??
                "This connection does not have permission to view terminals."
              }
            />
          ) : canOperateTerminal && launchLocation === null ? (
            sessionsError !== null ? (
              <EmptyState title="Could not load terminals" detail={sessionsError} />
            ) : (
              <EmptyState title="Loading terminals" detail="Reading existing terminal sessions." />
            )
          ) : !canOperateTerminal && !hasTerminalTarget && sessionsPending ? (
            <EmptyState title="Loading terminals" detail="Reading existing terminal sessions." />
          ) : !canOperateTerminal && !hasTerminalTarget && sessionsError !== null ? (
            <EmptyState title="Could not load terminals" detail={sessionsError} />
          ) : !canOperateTerminal && !hasTerminalTarget ? (
            <EmptyState
              title="No terminal sessions"
              detail="Existing terminals will appear here when another client opens one."
            />
          ) : !canOperateTerminal && terminal.error !== null ? (
            <EmptyState title="Terminal unavailable" detail={terminal.error} />
          ) : (
            <>
              <View
                style={{
                  flex: 1,
                  paddingBottom: terminalBottomInset,
                }}
              >
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: terminalTheme.background,
                  }}
                />
                <TerminalSurface
                  ref={surfaceRef}
                  autoFocus={canOperateTerminal && terminalAutoFocus}
                  readOnly={!canOperateTerminal}
                  buffer={terminal.version === 0 ? null : terminal.buffer}
                  output={terminal.version === 0 ? null : terminal.output}
                  fontSize={fontSize}
                  grid={terminal.grid}
                  isRunning={isRunning}
                  keyboardFocusRequest={keyboardFocusRequest}
                  captureRequest={captureRequest}
                  onCapture={(text) => {
                    setCaptureRequest(0);
                    if (text.trim()) setCapturedOutput(text);
                    else
                      Dialog.alert("No terminal output", "There is no visible output to attach.");
                  }}
                  onInput={handleInput}
                  onResize={handleResize}
                  style={{ flex: 1 }}
                  terminalKey={terminalKey}
                  theme={terminalTheme}
                />
              </View>

              {Platform.OS === "android" && !keyboardState.isVisible ? (
                <View className="min-h-14 flex-row items-center gap-2 bg-card-alt px-2">
                  {hasNativeTerminalSurface() ? (
                    <Button label="Attach output" tone="text" onPress={requestCapture} />
                  ) : null}
                  <View className="flex-1" />
                  <IconButton
                    accessibilityLabel="Show keyboard"
                    disabled={!canOperateTerminal}
                    icon="keyboard"
                    onPress={handleShowKeyboard}
                  />
                </View>
              ) : Platform.OS !== "android" && hasNativeTerminalSurface() ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    KeyboardController.dismiss();
                    requestCapture();
                  }}
                  className="px-4 pt-2"
                  style={{
                    paddingBottom:
                      8 +
                      (keyboardState.isVisible
                        ? 0
                        : (nativeColumnMetrics?.safeArea.bottom ?? insets.bottom)),
                  }}
                >
                  <Text style={{ color: terminalTheme.foreground }}>Attach visible output</Text>
                </Pressable>
              ) : null}
              {isAccessoryVisible ? (
                <KeyboardStickyView
                  style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
                  offset={{ closed: 0, opened: 0 }}
                >
                  <View
                    className="border-t"
                    style={{
                      backgroundColor: terminalTheme.background,
                      borderTopColor: terminalTheme.border,
                      minHeight: TERMINAL_ACCESSORY_HEIGHT,
                    }}
                  >
                    <ComposerToolbarRow paddingBottom={4} paddingHorizontal={8} paddingTop={4}>
                      <ComposerToolbarScroller
                        contentPaddingRight={2}
                        fadeOpaque={terminalTheme.background}
                        fadeTransparent={`${terminalTheme.background}00`}
                      >
                        {terminalToolbarActions.map((action) => {
                          const active =
                            action.kind === "modifier" && pendingModifier === action.modifier;

                          return (
                            <ComposerToolbarButton
                              key={action.key}
                              active={active}
                              label={action.label}
                              maxWidth={120}
                              minWidth={action.label.length > 1 ? 56 : 44}
                              onPress={() => handleToolbarActionPress(action)}
                              showChevron={false}
                              textTransform={
                                action.kind === "modifier" || action.kind === "clear"
                                  ? "uppercase"
                                  : "none"
                              }
                            />
                          );
                        })}
                      </ComposerToolbarScroller>
                      <ComposerToolbarButton
                        accessibilityLabel="Dismiss keyboard"
                        icon={{ ios: "keyboard.chevron.compact.down", android: "keyboard_hide" }}
                        onPress={handleDismissKeyboard}
                        showChevron={false}
                      />
                    </ComposerToolbarRow>
                  </View>
                </KeyboardStickyView>
              ) : canOperateTerminal && !keyboardState.isVisible && Platform.OS !== "android" ? (
                <Pressable
                  accessibilityLabel="Show keyboard"
                  accessibilityRole="button"
                  onPress={handleShowKeyboard}
                  style={({ pressed }) => ({
                    bottom: 16,
                    borderRadius: 28,
                    opacity: pressed ? 0.72 : 1,
                    position: "absolute",
                    right: 16,
                  })}
                >
                  <GlassSurface
                    chrome="none"
                    fallbackColor={terminalTheme.background}
                    glassEffectStyle="regular"
                    tintColor="transparent"
                    style={{
                      alignItems: "center",
                      borderRadius: 24,
                      height: 48,
                      justifyContent: "center",
                      width: 48,
                    }}
                    pointerEvents="none"
                  >
                    <SymbolView
                      name={{ ios: "keyboard", android: "keyboard" }}
                      size={20}
                      tintColor={terminalTheme.foreground}
                      type="monochrome"
                    />
                  </GlassSurface>
                </Pressable>
              ) : null}
            </>
          )}
        </View>
      </ScreenContent>
    </>
  );
}
