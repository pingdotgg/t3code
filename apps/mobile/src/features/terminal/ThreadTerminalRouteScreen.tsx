import {
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  type TerminalAttachStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import type { KnownTerminalSession } from "@t3tools/client-runtime";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text as RNText, View, useColorScheme } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadTerminalNavigation } from "../../lib/routes";
import { getEnvironmentClient } from "../../state/environment-session-registry";
import { useRemoteEnvironmentState } from "../../state/use-remote-environment-registry";
import {
  attachTerminalSession,
  useKnownTerminalSessions,
  useTerminalSession,
  useTerminalSessionTarget,
} from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { TerminalSurface } from "./NativeTerminalSurface";
import { getPierreTerminalTheme } from "./terminalTheme";
import { loadPreferences, savePreferencesPatch } from "../../lib/storage";
import { terminalDebugLog } from "./terminalDebugLog";
import {
  getTerminalBufferReplayKey,
  getTerminalSurfaceReplayBuffer,
  TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS,
} from "./terminalBufferReplay";
import { resolveTerminalRouteBootstrap } from "./terminalRouteBootstrap";
import {
  resolveTerminalOpenLocation,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "./terminalMenu";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  normalizeTerminalFontSize,
} from "./terminalPreferences";
import {
  cacheTerminalFontSize,
  cacheTerminalGridSize,
  getCachedTerminalFontSize,
  getCachedTerminalGridSize,
} from "./terminalUiState";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const TERMINAL_ACCESSORY_HEIGHT = 52;

type PendingModifier = "ctrl" | "meta";
type HostPlatform = "mac" | "linux" | "windows" | "unknown";

type TerminalToolbarAction =
  | { readonly kind: "send"; readonly key: string; readonly label: string; readonly data: string }
  | {
      readonly kind: "modifier";
      readonly key: string;
      readonly label: string;
      readonly modifier: PendingModifier;
    };

function getTerminalStatusTone(input: {
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess?: boolean;
}): {
  readonly tintColor: string;
  readonly textColor: string;
} {
  if (input.status === "running") {
    if (input.hasRunningSubprocess) {
      return {
        tintColor: "#fbbf24",
        textColor: "#a3a3a3",
      };
    }

    return {
      tintColor: "#34d399",
      textColor: "#a3a3a3",
    };
  }

  if (input.status === "starting") {
    return {
      tintColor: "#f59e0b",
      textColor: "#a3a3a3",
    };
  }

  if (input.status === "error") {
    return {
      tintColor: "#ef4444",
      textColor: "#fca5a5",
    };
  }

  return {
    tintColor: "#ef4444",
    textColor: "#a3a3a3",
  };
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function inferHostPlatform(environmentLabel: string | null): HostPlatform {
  const value = environmentLabel?.toLowerCase() ?? "";
  if (
    value.includes("mac") ||
    value.includes("macbook") ||
    value.includes("mac mini") ||
    value.includes("imac") ||
    value.includes("darwin")
  ) {
    return "mac";
  }
  if (value.includes("windows") || value.includes("win")) {
    return "windows";
  }
  if (value.includes("linux") || value.includes("ubuntu") || value.includes("debian")) {
    return "linux";
  }

  return "unknown";
}

function applyCtrlModifier(input: string): string {
  const firstCharacter = input[0];
  if (!firstCharacter) {
    return input;
  }

  const lowerCharacter = firstCharacter.toLowerCase();
  if (lowerCharacter >= "a" && lowerCharacter <= "z") {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96);
  }

  if (firstCharacter === "@") return "\u0000";
  if (firstCharacter === "[") return "\u001b";
  if (firstCharacter === "\\") return "\u001c";
  if (firstCharacter === "]") return "\u001d";
  if (firstCharacter === "^") return "\u001e";
  if (firstCharacter === "_") return "\u001f";
  if (firstCharacter === "?") return "\u007f";

  return input;
}

function withAlpha(hexColor: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(hexColor) ? `${hexColor}${alpha}` : hexColor;
}

function pickRunningTerminalSessionForBootstrap(
  sessions: ReadonlyArray<KnownTerminalSession>,
): KnownTerminalSession | null {
  const running = sessions.filter(
    (session) => session.state.status === "running" || session.state.status === "starting",
  );
  if (running.length === 0) {
    return null;
  }
  return (
    running.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID) ??
    running[0] ??
    null
  );
}

export function ThreadTerminalRouteScreen() {
  const router = useRouter();
  const keyboard = useAnimatedKeyboard();
  const appearanceScheme = useColorScheme() === "light" ? "light" : "dark";
  const { isLoadingSavedConnection } = useRemoteEnvironmentState();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
    terminalId?: string | string[];
  }>();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const routeEnvironmentIdRaw = firstRouteParam(params.environmentId);
  const routeThreadIdRaw = firstRouteParam(params.threadId);
  const routeEnvironmentId = routeEnvironmentIdRaw
    ? EnvironmentId.make(routeEnvironmentIdRaw)
    : null;
  const routeThreadId = routeThreadIdRaw ? ThreadId.make(routeThreadIdRaw) : null;
  const requestedTerminalId = firstRouteParam(params.terminalId);
  const terminalId = requestedTerminalId ?? DEFAULT_TERMINAL_ID;
  const cachedFontSize = getCachedTerminalFontSize();
  const cachedRouteGridSize =
    routeEnvironmentId && routeThreadId
      ? getCachedTerminalGridSize({
          environmentId: routeEnvironmentId,
          threadId: routeThreadId,
          terminalId,
        })
      : null;
  const knownSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const [lastGridSize, setLastGridSize] = useState(
    cachedRouteGridSize ?? {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    },
  );
  const [fontSize, setFontSize] = useState(cachedFontSize ?? DEFAULT_TERMINAL_FONT_SIZE);
  const hasOpenedRef = useRef(false);
  const bufferReplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachStreamLogCountRef = useRef(0);
  const firstNonEmptyBufferLoggedRef = useRef(false);
  const lastBufferReplayKeyRef = useRef<string | null>(null);
  const [readyBufferReplayKey, setReadyBufferReplayKey] = useState<string | null>(null);
  const [hasResolvedFontPreference, setHasResolvedFontPreference] = useState(
    cachedFontSize !== null,
  );
  /** Default grid is always valid for attach; onResize refines cols/rows. Requiring a cached size blocked bootstrap for new terminal routes. */
  const [hasMeasuredSurface, setHasMeasuredSurface] = useState(true);
  const [pendingModifierState, setPendingModifierState] = useState<{
    readonly terminalId: string;
    readonly value: PendingModifier | null;
  }>({
    terminalId,
    value: null,
  });
  const target = useTerminalSessionTarget({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    terminalId,
  });
  const terminal = useTerminalSession(target);
  const terminalKey = selectedThread
    ? `${selectedThread.environmentId}:${selectedThread.id}:${terminalId}`
    : terminalId;
  const bufferReplayKey = useMemo(
    () => getTerminalBufferReplayKey({ terminalKey, fontSize }),
    [fontSize, terminalKey],
  );
  if (lastBufferReplayKeyRef.current === null) {
    lastBufferReplayKeyRef.current = bufferReplayKey;
  }
  const terminalSurfaceBuffer = getTerminalSurfaceReplayBuffer({
    buffer: terminal.buffer,
    replayKey: bufferReplayKey,
    readyReplayKey: readyBufferReplayKey,
  });
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  useEffect(() => {
    terminalDebugLog("surface:props", {
      terminalKey,
      atomBufferLen: terminal.buffer.length,
      surfaceBufferLen: terminalSurfaceBuffer.length,
      replayKey: bufferReplayKey,
      readyReplayKey: readyBufferReplayKey,
      status: terminal.status,
      version: terminal.version,
    });
  }, [
    bufferReplayKey,
    readyBufferReplayKey,
    terminal.buffer.length,
    terminal.status,
    terminal.version,
    terminalKey,
    terminalSurfaceBuffer.length,
  ]);

  useEffect(() => {
    terminalDebugLog("session:status", {
      terminalKey,
      status: terminal.status,
      error: terminal.error,
      summary: terminal.summary?.cwd ?? null,
      bufferLen: terminal.buffer.length,
      version: terminal.version,
    });
  }, [
    terminal.buffer.length,
    terminal.error,
    terminal.status,
    terminal.summary?.cwd,
    terminal.version,
    terminalKey,
  ]);

  useEffect(() => {
    if (terminal.buffer.length === 0 || firstNonEmptyBufferLoggedRef.current) {
      return;
    }
    firstNonEmptyBufferLoggedRef.current = true;
    terminalDebugLog("session:first-nonempty-buffer", {
      terminalKey,
      length: terminal.buffer.length,
      preview: terminal.buffer.slice(0, 160),
    });
  }, [terminal.buffer, terminal.buffer.length, terminalKey]);
  const cwd = terminal.summary?.cwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const hostPlatform = useMemo(
    () => inferHostPlatform(selectedEnvironmentConnection?.environmentLabel ?? null),
    [selectedEnvironmentConnection?.environmentLabel],
  );
  const runningSession = useMemo(
    () => pickRunningTerminalSessionForBootstrap(knownSessions),
    [knownSessions],
  );
  const activeKnownSession = useMemo(
    () => knownSessions.find((session) => session.target.terminalId === terminalId) ?? null,
    [knownSessions, terminalId],
  );

  const terminalAttachLaunchHintsRef = useRef({
    terminalSummary: terminal.summary,
    activeKnownSummary: activeKnownSession?.state.summary ?? null,
  });
  terminalAttachLaunchHintsRef.current = {
    terminalSummary: terminal.summary,
    activeKnownSummary: activeKnownSession?.state.summary ?? null,
  };

  const terminalStatusTone = useMemo(
    () =>
      getTerminalStatusTone({
        status: terminal.status,
        hasRunningSubprocess: terminal.hasRunningSubprocess,
      }),
    [terminal.hasRunningSubprocess, terminal.status],
  );
  const terminalTheme = getPierreTerminalTheme(appearanceScheme);
  const pendingModifier =
    pendingModifierState.terminalId === terminalId ? pendingModifierState.value : null;
  const headerTitle = useMemo(() => {
    const topLineParts = [
      selectedEnvironmentConnection?.environmentLabel ?? null,
      selectedThreadProject?.title ?? null,
    ].filter((value): value is string => Boolean(value));

    return {
      topLine: topLineParts.join(" \u00b7 "),
      bottomLine: cwd ?? selectedThreadProject?.workspaceRoot ?? "",
    };
  }, [
    cwd,
    selectedEnvironmentConnection?.environmentLabel,
    selectedThreadProject?.title,
    selectedThreadProject?.workspaceRoot,
  ]);
  const terminalToolbarActions = useMemo<ReadonlyArray<TerminalToolbarAction>>(() => {
    const modifierActions: ReadonlyArray<TerminalToolbarAction> =
      hostPlatform === "mac"
        ? [
            { kind: "modifier", key: "cmd", label: "cmd", modifier: "meta" },
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
          ]
        : [
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
            { kind: "modifier", key: "alt", label: "alt", modifier: "meta" },
          ];

    return [
      { kind: "send", key: "esc", label: "esc", data: "\u001b" },
      ...modifierActions,
      { kind: "send", key: "tab", label: "tab", data: "\t" },
      { kind: "send", key: "up", label: "↑", data: "\u001b[A" },
      { kind: "send", key: "down", label: "↓", data: "\u001b[B" },
      { kind: "send", key: "left", label: "←", data: "\u001b[D" },
      { kind: "send", key: "right", label: "→", data: "\u001b[C" },
      { kind: "send", key: "tilde", label: "~", data: "~" },
      { kind: "send", key: "pipe", label: "|", data: "|" },
      { kind: "send", key: "slash", label: "/", data: "/" },
      { kind: "send", key: "dash", label: "-", data: "-" },
    ];
  }, [hostPlatform]);
  const terminalBottomInset = TERMINAL_ACCESSORY_HEIGHT;
  const terminalContainerAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom:
      keyboard.height.value > 0
        ? keyboard.height.value + TERMINAL_ACCESSORY_HEIGHT
        : terminalBottomInset,
  }));

  const terminalMenuSessions = useMemo<ReadonlyArray<TerminalMenuSession>>(
    () =>
      buildTerminalMenuSessions({
        knownSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
        currentSession: {
          terminalId,
          cwd: cwd ?? null,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          displayLabel: resolveTerminalSessionLabel(terminalId, terminal.summary),
          updatedAt: terminal.updatedAt,
        },
      }),
    [
      cwd,
      knownSessions,
      selectedThreadProject?.workspaceRoot,
      terminal.hasRunningSubprocess,
      terminal.summary,
      terminal.status,
      terminal.updatedAt,
      terminalId,
    ],
  );

  const logAttachStreamEvent = useCallback((event: TerminalAttachStreamEvent) => {
    const n = ++attachStreamLogCountRef.current;
    if (event.type === "output" && n > 32 && n % 64 !== 0) {
      return;
    }
    if (event.type === "snapshot") {
      terminalDebugLog("attach:stream", {
        n,
        type: event.type,
        status: event.snapshot.status,
        historyLen: event.snapshot.history.length,
        cwd: event.snapshot.cwd,
      });
      return;
    }
    if (event.type === "output") {
      terminalDebugLog("attach:stream", { n, type: event.type, dataLen: event.data.length });
      return;
    }
    terminalDebugLog("attach:stream", { n, type: event.type });
  }, []);

  const attachTerminal = useCallback(() => {
    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      terminalDebugLog("attach:abort", { reason: "no-thread-or-workspace" });
      return null;
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      terminalDebugLog("attach:abort", {
        reason: "no-environment-client",
        environmentId: selectedThread.environmentId,
      });
      return null;
    }

    const pendingLaunchTarget = {
      environmentId: selectedThread.environmentId,
      threadId: selectedThread.id,
      terminalId,
    };
    const pendingLaunch = takePendingTerminalLaunch(pendingLaunchTarget);
    let initialInputSent = false;

    try {
      const launchLocation = pendingLaunch
        ? {
            cwd: pendingLaunch.cwd,
            worktreePath: pendingLaunch.worktreePath,
          }
        : resolveTerminalOpenLocation({
            terminalLocation: terminalAttachLaunchHintsRef.current.terminalSummary,
            activeSessionLocation: terminalAttachLaunchHintsRef.current.activeKnownSummary,
            workspaceRoot: selectedThreadProject.workspaceRoot,
            threadShellWorktreePath: selectedThread.worktreePath ?? null,
            threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
          });

      terminalDebugLog("attach:start", {
        terminalId,
        threadId: selectedThread.id,
        cols: lastGridSize.cols,
        rows: lastGridSize.rows,
        cwd: launchLocation.cwd,
        worktreePath: launchLocation.worktreePath,
      });

      return attachTerminalSession({
        environmentId: selectedThread.environmentId,
        client,
        terminal: {
          threadId: selectedThread.id,
          terminalId,
          cwd: launchLocation.cwd,
          worktreePath: launchLocation.worktreePath,
          cols: lastGridSize.cols,
          rows: lastGridSize.rows,
          env: pendingLaunch?.env,
        },
        onEvent: logAttachStreamEvent,
        onSnapshot: () => {
          if (!pendingLaunch?.initialInput || initialInputSent) {
            return;
          }

          initialInputSent = true;
          void client.terminal.write({
            threadId: selectedThread.id,
            terminalId,
            data: pendingLaunch.initialInput,
          });
        },
      });
    } catch (error) {
      terminalDebugLog("attach:error", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (pendingLaunch) {
        stagePendingTerminalLaunch({
          target: pendingLaunchTarget,
          launch: pendingLaunch,
        });
      }

      throw error;
    }
  }, [
    lastGridSize.cols,
    lastGridSize.rows,
    logAttachStreamEvent,
    selectedThreadDetail?.worktreePath,
    selectedThread,
    selectedThreadProject?.workspaceRoot,
    terminalId,
  ]);

  const attachTerminalRef = useRef(attachTerminal);
  attachTerminalRef.current = attachTerminal;
  const selectedThreadRef = useRef(selectedThread);
  selectedThreadRef.current = selectedThread;
  const selectedThreadProjectBootstrapRef = useRef(selectedThreadProject);
  selectedThreadProjectBootstrapRef.current = selectedThreadProject;
  const runningSessionRef = useRef(runningSession);
  runningSessionRef.current = runningSession;
  const terminalBootstrapRef = useRef({
    status: terminal.status,
    bufferLen: terminal.buffer.length,
  });
  terminalBootstrapRef.current = {
    status: terminal.status,
    bufferLen: terminal.buffer.length,
  };

  useEffect(() => {
    hasOpenedRef.current = false;
    attachStreamLogCountRef.current = 0;
    firstNonEmptyBufferLoggedRef.current = false;
  }, [terminalKey]);

  const clearBufferReplayTimer = useCallback(() => {
    if (bufferReplayTimerRef.current !== null) {
      clearTimeout(bufferReplayTimerRef.current);
      bufferReplayTimerRef.current = null;
    }
  }, []);

  const scheduleBufferReplayReady = useCallback(() => {
    clearBufferReplayTimer();
    const replayKey = bufferReplayKey;
    terminalDebugLog("replay:schedule-ready", {
      replayKey,
      delayMs: TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS,
    });
    bufferReplayTimerRef.current = setTimeout(() => {
      bufferReplayTimerRef.current = null;
      setReadyBufferReplayKey(replayKey);
      terminalDebugLog("replay:ready", { replayKey });
    }, TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS);
  }, [bufferReplayKey, clearBufferReplayTimer]);

  useEffect(() => {
    if (lastBufferReplayKeyRef.current === bufferReplayKey) {
      return;
    }

    lastBufferReplayKeyRef.current = bufferReplayKey;
    clearBufferReplayTimer();
    setReadyBufferReplayKey(null);
  }, [bufferReplayKey, clearBufferReplayTimer]);

  useEffect(() => clearBufferReplayTimer, [clearBufferReplayTimer]);

  useEffect(() => {
    if (!routeEnvironmentId || !routeThreadId) {
      setLastGridSize({
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      });
      return;
    }

    setLastGridSize(
      getCachedTerminalGridSize({
        environmentId: routeEnvironmentId,
        threadId: routeThreadId,
        terminalId,
      }) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
    );
    setHasMeasuredSurface(true);
  }, [routeEnvironmentId, routeThreadId, terminalId]);

  useEffect(() => {
    let cancelled = false;

    void loadPreferences()
      .then((preferences) => {
        if (cancelled) {
          return;
        }

        setFontSize(cacheTerminalFontSize(preferences.terminalFontSize));
        setHasResolvedFontPreference(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setHasResolvedFontPreference(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasResolvedFontPreference) {
      return;
    }

    cacheTerminalFontSize(fontSize);
    void savePreferencesPatch({
      terminalFontSize: normalizeTerminalFontSize(fontSize),
    });
  }, [fontSize, hasResolvedFontPreference]);

  // Subscribes `terminal.attach` once per route+terminal until thread/env/attach args change.
  // Use refs for `attachTerminal` / `selectedThread` / `runningSession`: their identities change when
  // unrelated store updates (e.g. terminal buffer) re-render the parent, which was firing cleanup
  // → detach immediately after the first snapshot.
  useEffect(() => {
    if (!hasResolvedFontPreference || !hasMeasuredSurface) {
      return;
    }

    const thread = selectedThreadRef.current;
    const project = selectedThreadProjectBootstrapRef.current;
    const running = runningSessionRef.current;
    const termSnap = terminalBootstrapRef.current;

    const bootstrapAction = resolveTerminalRouteBootstrap({
      hasThread: thread !== null,
      hasWorkspaceRoot: Boolean(project?.workspaceRoot),
      hasOpened: hasOpenedRef.current,
      requestedTerminalId,
      currentTerminalId: terminalId,
      runningTerminalId: running?.target.terminalId ?? null,
      currentTerminalStatus: termSnap.status,
      // Metadata summary (cwd/status) is not scrollback. Only `terminal.attach` fills `buffer`;
      // treating summary as "hydrated" skipped attach while status was running → empty surface.
      hasCurrentTerminalHydration: termSnap.bufferLen > 0,
    });
    if (bootstrapAction.kind !== "idle") {
      terminalDebugLog("bootstrap:action", {
        kind: bootstrapAction.kind,
        hasOpenedBefore: hasOpenedRef.current,
        hasHydration: termSnap.bufferLen > 0,
        terminalStatus: termSnap.status,
        bufLen: termSnap.bufferLen,
      });
    }
    if (bootstrapAction.kind === "idle" || !thread) {
      return;
    }

    if (bootstrapAction.kind === "redirect") {
      router.replace(buildThreadTerminalNavigation(thread, bootstrapAction.terminalId));
      return;
    }

    hasOpenedRef.current = true;
    try {
      const detach = attachTerminalRef.current();
      terminalDebugLog("bootstrap:subscribe", { hasDetach: Boolean(detach) });
      if (!detach) {
        hasOpenedRef.current = false;
        return;
      }
      return () => {
        detach();
        hasOpenedRef.current = false;
        terminalDebugLog("bootstrap:unsubscribe");
      };
    } catch (error) {
      hasOpenedRef.current = false;
      terminalDebugLog("bootstrap:attach-threw", {
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }, [
    hasMeasuredSurface,
    hasResolvedFontPreference,
    requestedTerminalId,
    router,
    selectedThread?.environmentId,
    selectedThread?.id,
    selectedThreadProject?.workspaceRoot,
    terminalId,
  ]);

  const writeInput = useCallback(
    (data: string) => {
      if (!selectedThread || !isRunning) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      void client.terminal.write({
        threadId: selectedThread.id,
        terminalId,
        data,
      });
    },
    [isRunning, selectedThread, terminalId],
  );

  const handleInput = useCallback(
    (data: string) => {
      if (data.length === 0) {
        return;
      }

      if (pendingModifier === "ctrl") {
        setPendingModifierState({ terminalId, value: null });
        writeInput(applyCtrlModifier(data));
      } else if (pendingModifier === "meta") {
        setPendingModifierState({ terminalId, value: null });
        writeInput(`\u001b${data}`);
      } else {
        writeInput(data);
      }
    },
    [pendingModifier, terminalId, writeInput],
  );

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      terminalDebugLog("native:onResize", {
        cols: size.cols,
        rows: size.rows,
        terminalKey,
      });
      setHasMeasuredSurface(true);
      if (readyBufferReplayKey !== bufferReplayKey) {
        scheduleBufferReplayReady();
      }
      if (routeEnvironmentId && routeThreadId) {
        cacheTerminalGridSize(
          {
            environmentId: routeEnvironmentId,
            threadId: routeThreadId,
            terminalId,
          },
          size,
        );
      }
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) {
        return;
      }

      setLastGridSize(size);
      if (!selectedThread || !isRunning) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      void client.terminal.resize({
        threadId: selectedThread.id,
        terminalId,
        cols: size.cols,
        rows: size.rows,
      });
    },
    [
      isRunning,
      lastGridSize.cols,
      lastGridSize.rows,
      bufferReplayKey,
      readyBufferReplayKey,
      routeEnvironmentId,
      routeThreadId,
      scheduleBufferReplayReady,
      selectedThread,
      terminalId,
      terminalKey,
    ],
  );

  const handleSelectTerminal = useCallback(
    (nextTerminalId: string) => {
      if (!selectedThread || nextTerminalId === terminalId) {
        return;
      }

      router.replace(buildThreadTerminalNavigation(selectedThread, nextTerminalId));
    },
    [router, selectedThread, terminalId],
  );

  const handleOpenNewTerminal = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    router.replace(
      buildThreadTerminalNavigation(
        selectedThread,
        nextOpenTerminalId({
          listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
          activeRouteTerminalId: terminalId,
        }),
      ),
    );
  }, [router, selectedThread, terminalId, terminalMenuSessions]);

  const adjustFontSize = useCallback((delta: number) => {
    setTimeout(() => {
      setFontSize((current) => cacheTerminalFontSize(current + delta));
    }, 0);
  }, []);

  const handleDecreaseFontSize = useCallback(() => {
    adjustFontSize(-TERMINAL_FONT_SIZE_STEP);
  }, [adjustFontSize]);

  const handleIncreaseFontSize = useCallback(() => {
    adjustFontSize(TERMINAL_FONT_SIZE_STEP);
  }, [adjustFontSize]);

  const handleToolbarActionPress = useCallback(
    (action: TerminalToolbarAction) => {
      if (action.kind === "modifier") {
        setPendingModifierState((current) => ({
          terminalId,
          value:
            (current.terminalId === terminalId ? current.value : null) === action.modifier
              ? null
              : action.modifier,
        }));
        return;
      }

      setPendingModifierState({ terminalId, value: null });
      if (pendingModifier === "ctrl") {
        writeInput(applyCtrlModifier(action.data));
      } else if (pendingModifier === "meta") {
        writeInput(`\u001b${action.data}`);
      } else {
        writeInput(action.data);
      }
    },
    [pendingModifier, terminalId, writeInput],
  );

  if (!selectedThread) {
    if (isLoadingSavedConnection) {
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

  if (!selectedThreadProject?.workspaceRoot) {
    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Terminal unavailable"
          detail="This thread does not have a workspace root yet, so there is nowhere to open a shell."
        />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: terminalTheme.background },
          headerTintColor: terminalTheme.foreground,
          headerTitleAlign: "center",
          title: "",
          headerTitle: () => (
            <View
              style={{
                alignItems: "center",
                gap: 1,
                maxWidth: 240,
              }}
            >
              <RNText
                numberOfLines={1}
                style={{
                  color: terminalTheme.foreground,
                  fontFamily: "DMSans_700Bold",
                  fontSize: 13,
                  lineHeight: 16,
                }}
              >
                {headerTitle.topLine}
              </RNText>
              <RNText
                ellipsizeMode="middle"
                numberOfLines={1}
                style={{
                  color: terminalTheme.mutedForeground,
                  fontFamily: "Menlo",
                  fontSize: 11,
                  lineHeight: 14,
                }}
              >
                {headerTitle.bottomLine}
              </RNText>
            </View>
          ),
        }}
      />

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon="circle.fill"
          style={{
            color: terminalStatusTone.textColor,
            fontFamily: "DMSans_700Bold",
            fontSize: 12,
            fontWeight: "700",
          }}
          tintColor={terminalStatusTone.tintColor}
          title="Terminal options"
        >
          <Stack.Toolbar.Label>
            {getTerminalStatusLabel({
              status: terminal.status,
              hasRunningSubprocess: terminal.hasRunningSubprocess,
            })}
          </Stack.Toolbar.Label>
          <Stack.Toolbar.Menu icon="textformat.size" inline title="Text size">
            <Stack.Toolbar.Label>Text size</Stack.Toolbar.Label>
            <Stack.Toolbar.MenuAction
              disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
              discoverabilityLabel="Decrease terminal text size"
              onPress={handleDecreaseFontSize}
            >
              <Stack.Toolbar.Label>{`A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
              discoverabilityLabel="Increase terminal text size"
              onPress={handleIncreaseFontSize}
            >
              <Stack.Toolbar.Label>{`A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          {terminalMenuSessions.map((session) => (
            <Stack.Toolbar.MenuAction
              key={session.terminalId}
              icon={session.terminalId === terminalId ? "checkmark" : "terminal"}
              onPress={() => handleSelectTerminal(session.terminalId)}
              subtitle={[getTerminalStatusLabel({ status: session.status }), basename(session.cwd)]
                .filter(Boolean)
                .join(" · ")}
            >
              <Stack.Toolbar.Label>{session.displayLabel}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon="plus"
            onPress={handleOpenNewTerminal}
            subtitle={`Start another shell in ${basename(selectedThreadProject.workspaceRoot) ?? "this workspace"}`}
          >
            <Stack.Toolbar.Label>Open new terminal</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <View style={{ flex: 1, backgroundColor: terminalTheme.background }}>
        <Animated.View style={[{ flex: 1 }, terminalContainerAnimatedStyle]}>
          <TerminalSurface
            buffer={terminalSurfaceBuffer}
            fontSize={fontSize}
            isRunning={isRunning}
            onInput={handleInput}
            onResize={handleResize}
            style={{ flex: 1 }}
            terminalKey={terminalKey}
          />
        </Animated.View>

        <KeyboardStickyView style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
          <View
            style={{
              backgroundColor: terminalTheme.background,
              borderTopColor: terminalTheme.border,
              borderTopWidth: 1,
              minHeight: TERMINAL_ACCESSORY_HEIGHT,
              paddingBottom: 4,
              paddingHorizontal: 8,
              paddingTop: 4,
            }}
          >
            <ScrollView
              horizontal
              contentContainerStyle={{ alignItems: "center", gap: 6, paddingRight: 2 }}
              showsHorizontalScrollIndicator={false}
            >
              {terminalToolbarActions.map((action) => {
                const active = action.kind === "modifier" && pendingModifier === action.modifier;

                return (
                  <Pressable
                    key={action.key}
                    onPress={() => handleToolbarActionPress(action)}
                    style={({ pressed }) => ({
                      alignItems: "center",
                      backgroundColor: active
                        ? withAlpha(terminalTheme.palette[10] ?? terminalTheme.foreground, "2e")
                        : pressed
                          ? withAlpha(terminalTheme.foreground, "1f")
                          : withAlpha(terminalTheme.foreground, "12"),
                      borderColor: active
                        ? withAlpha(terminalTheme.palette[10] ?? terminalTheme.foreground, "52")
                        : terminalTheme.border,
                      borderRadius: 12,
                      borderWidth: 1,
                      justifyContent: "center",
                      minWidth: action.label.length > 1 ? 46 : 38,
                      paddingHorizontal: 11,
                      paddingVertical: 8,
                    })}
                  >
                    <RNText
                      style={{
                        color: active
                          ? (terminalTheme.palette[10] ?? terminalTheme.foreground)
                          : terminalTheme.foreground,
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        textTransform: action.kind === "modifier" ? "uppercase" : "none",
                      }}
                    >
                      {action.label}
                    </RNText>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </KeyboardStickyView>
      </View>
    </>
  );
}
