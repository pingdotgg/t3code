import { DEFAULT_TERMINAL_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { getEnvironmentClient } from "../../state/environment-session-registry";
import {
  attachTerminalSession,
  useTerminalSession,
  useTerminalSessionTarget,
} from "../../state/use-terminal-session";
import { TerminalSurface } from "./NativeTerminalSurface";
import { hasNativeTerminalSurface } from "./nativeTerminalModule";
import { terminalDebugLog } from "./terminalDebugLog";

interface ThreadTerminalPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly visible: boolean;
  readonly onClose: () => void;
}

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

export const ThreadTerminalPanel = memo(function ThreadTerminalPanel(
  props: ThreadTerminalPanelProps,
) {
  const nativeTerminalAvailable = hasNativeTerminalSurface();
  const terminalId = DEFAULT_TERMINAL_ID;
  const target = useTerminalSessionTarget({
    environmentId: props.environmentId,
    threadId: props.threadId,
    terminalId,
  });
  const terminal = useTerminalSession(target);
  const [lastGridSize, setLastGridSize] = useState({
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
  });

  const terminalKey = `${props.environmentId}:${props.threadId}:${terminalId}`;
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  useEffect(() => {
    if (!props.visible) {
      return;
    }

    const client = getEnvironmentClient(props.environmentId);
    if (!client) {
      terminalDebugLog("panel:attach-skip", {
        reason: "no-environment-client",
        environmentId: props.environmentId,
      });
      return;
    }

    terminalDebugLog("panel:attach", {
      environmentId: props.environmentId,
      threadId: props.threadId,
      terminalId,
    });

    return attachTerminalSession({
      environmentId: props.environmentId,
      client,
      terminal: {
        threadId: props.threadId,
        terminalId,
        cwd: props.cwd,
        worktreePath: props.worktreePath,
        cols: lastGridSize.cols,
        rows: lastGridSize.rows,
      },
    });
  }, [
    lastGridSize.cols,
    lastGridSize.rows,
    props.cwd,
    props.environmentId,
    props.threadId,
    props.worktreePath,
    props.visible,
    terminalId,
  ]);

  const handleInput = useCallback(
    (data: string) => {
      const client = getEnvironmentClient(props.environmentId);
      if (!client || !isRunning) {
        return;
      }

      void client.terminal.write({
        threadId: props.threadId,
        terminalId,
        data,
      });
    },
    [isRunning, props.environmentId, props.threadId, terminalId],
  );

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) {
        return;
      }

      setLastGridSize(size);
      const client = getEnvironmentClient(props.environmentId);
      if (!client || !isRunning) {
        return;
      }

      void client.terminal.resize({
        threadId: props.threadId,
        terminalId,
        cols: size.cols,
        rows: size.rows,
      });
    },
    [
      isRunning,
      lastGridSize.cols,
      lastGridSize.rows,
      props.environmentId,
      props.threadId,
      terminalId,
    ],
  );

  if (!props.visible) {
    return null;
  }

  return (
    <View className="absolute inset-x-3 bottom-28 top-28 overflow-hidden rounded-[8px] border border-white/10 bg-neutral-950 shadow-2xl">
      <View className="flex-row items-center justify-between border-b border-white/10 px-3 py-2">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-[13px] text-neutral-100" numberOfLines={1}>
            Terminal
          </Text>
          <Text className="text-[11px] text-neutral-500" numberOfLines={1}>
            {nativeTerminalAvailable ? "Native Ghostty surface" : "Text fallback active"}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          {terminal.error ? (
            <Text className="max-w-44 text-right text-[11px] text-red-300" numberOfLines={1}>
              {terminal.error}
            </Text>
          ) : null}
          <Pressable
            className="h-8 w-8 items-center justify-center rounded-[8px] bg-white/10"
            onPress={props.onClose}
          >
            <SymbolView name="xmark" size={13} tintColor="#e5e5e5" type="monochrome" />
          </Pressable>
        </View>
      </View>
      <TerminalSurface
        terminalKey={terminalKey}
        buffer={terminal.buffer}
        isRunning={isRunning}
        onInput={handleInput}
        onResize={handleResize}
        style={{ flex: 1 }}
      />
    </View>
  );
});
