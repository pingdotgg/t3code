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
import { TerminalHeader } from "./ThreadTerminalRouteScreenParts";
import type { ThreadTerminalRouteScreenProps } from "./ThreadTerminalRouteScreen";
import { ThreadTerminal, firstRouteParam, pickRunningTerminalSessionForBootstrap, useTerminalAccess } from "./ThreadTerminalRouteScreen";

export function ThreadTerminalRouteScreen(props: ThreadTerminalRouteScreenProps) {
  const connectionsReady = useConnectionsReady();
  const params = props.route.params;
  const selection = useThreadSelection();
  const { selectedThread } = selection;
  const routeEnvironmentIdRaw = firstRouteParam(params.environmentId);
  const routeEnvironmentId = routeEnvironmentIdRaw
    ? EnvironmentId.make(routeEnvironmentIdRaw)
    : null;
  const access = useTerminalAccess(routeEnvironmentId);
  const knownSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const requestedTerminalId = firstRouteParam(params.terminalId);
  // A route without a terminal shows the thread's running one. The choice is
  // made once, from the first session list that has one, so the terminal shown
  // does not change under the user as sessions come and go.
  const [bootstrapTerminalId, setBootstrapTerminalId] = useState<string | null>(null);
  const runningSession = knownSessions.sessions
    ? (pickRunningTerminalSessionForBootstrap(knownSessions.sessions) ??
      (access.canOperate ? null : (knownSessions.sessions[0] ?? null)))
    : null;
  if (
    requestedTerminalId === null &&
    bootstrapTerminalId === null &&
    runningSession !== null &&
    runningSession.target.terminalId !== DEFAULT_TERMINAL_ID
  ) {
    setBootstrapTerminalId(runningSession.target.terminalId);
  }
  const explicitTerminalId = requestedTerminalId ?? bootstrapTerminalId;
  const terminalId = explicitTerminalId ?? DEFAULT_TERMINAL_ID;

  if (!selectedThread) {
    if (!connectionsReady) {
      return <LoadingScreen message="Opening terminal…" />;
    }

    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Thread unavailable"
          detail="This terminal route needs an active thread and workspace."
        />
      </View>
    );
  }

  return (
    <ThreadTerminal
      key={`${selectedThread.environmentId}:${selectedThread.id}:${terminalId}`}
      params={params}
      routeEnvironmentId={routeEnvironmentId}
      selection={selection}
      thread={selectedThread}
      terminalId={terminalId}
      hasExplicitTerminalId={explicitTerminalId !== null}
      access={access}
      knownSessions={knownSessions}
    />
  );
}

