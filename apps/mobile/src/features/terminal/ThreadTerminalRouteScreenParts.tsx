import * as Dialog from "../../components/ui/Dialog";
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppBar } from "../../components/ui/AppBar";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomMount } from "@effect/atom-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { TerminalContextSheet } from "./TerminalContextSheet";
import { hasNativeTerminalSurface, supportsNativeTerminalOutput } from "./nativeTerminalModule";
import * as Clipboard from "expo-clipboard";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";

import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { EmptyState } from "../../components/ui/EmptyState";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { LoadingScreen } from "../../components/LoadingScreen";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { terminalEnvironment } from "../../state/terminal";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { useServerConfigs } from "../../state/entities";
import { useConnectionsReady } from "../../state/workspace";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  stepTerminalFontSize,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { TerminalSurface, type TerminalSurfaceHandle } from "./NativeTerminalSurface";
import { getMobileTerminalTheme } from "./terminalTheme";
import { useTerminalExitNavigation } from "./useTerminalExitNavigation";
import {
  useInitialTerminalLaunchLocation,
  takePendingTerminalLaunch,
  type PendingTerminalLaunch,
} from "./terminalLaunchContext";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "./terminalMenu";
import {
  hostPlatformFromOs,
  resolveModifiedTerminalInput,
  type HostPlatform,
  type PendingModifier,
} from "./terminalInput";
import { createTerminalPasteSession } from "./terminalPaste";
import { cacheTerminalGridSize, getCachedTerminalGridSize } from "./terminalUiState";

export function TerminalHeader(props: {
  readonly subtitle: string;
  readonly isEnvironmentReady: boolean;
  readonly canOperateTerminal: boolean;
  readonly fontSize: number;
  readonly terminalId: string;
  readonly sessions: ReadonlyArray<TerminalMenuSession>;
  readonly status: Parameters<typeof getTerminalStatusLabel>[0];
  readonly workspaceRoot: string;
  readonly onCloseTerminal: () => void;
  readonly onDecreaseFontSize: () => void;
  readonly onIncreaseFontSize: () => void;
  readonly onOpenNewTerminal: () => void;
  readonly onSelectTerminal: (terminalId: string) => void;
}) {
  return (
    <AppBar
      title="Terminal"
      subtitle={props.subtitle}
      onBack={props.onCloseTerminal}
      backInSplitView={{
        accessibilityLabel: "Back to chat",
        icon: "chevron.left",
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
                    disabled: !props.canOperateTerminal,
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

