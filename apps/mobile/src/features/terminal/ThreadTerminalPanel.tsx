import { DEFAULT_TERMINAL_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAttachedTerminalSession } from "../../state/use-terminal-session";
import { TerminalSurface } from "./NativeTerminalSurface";
import { hasNativeTerminalSurface } from "./nativeTerminalModule";
import {
  buildThreadTerminalAttachInput,
  type TerminalGridSize,
  type ThreadTerminalSubscriptionIdentity,
} from "./threadTerminalPanelModel";

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
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const resizeTerminal = useAtomCommand(terminalEnvironment.resize, "terminal resize");
  const nativeTerminalAvailable = hasNativeTerminalSurface();
  const terminalId = DEFAULT_TERMINAL_ID;
  const lastGridSizeRef = useRef<TerminalGridSize>({
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
  });
  const subscriptionIdentity = useMemo<ThreadTerminalSubscriptionIdentity>(
    () => ({
      environmentId: props.environmentId,
      threadId: props.threadId,
      terminalId,
      cwd: props.cwd,
      worktreePath: props.worktreePath,
    }),
    [props.cwd, props.environmentId, props.threadId, props.worktreePath, terminalId],
  );
  const attachInput = useMemo(
    () =>
      props.visible
        ? buildThreadTerminalAttachInput(subscriptionIdentity, lastGridSizeRef.current)
        : null,
    [props.visible, subscriptionIdentity],
  );
  const terminal = useAttachedTerminalSession({
    environmentId: props.environmentId,
    terminal: attachInput,
  });

  const terminalKey = `${props.environmentId}:${props.threadId}:${terminalId}`;
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  const sendResize = useCallback(
    (size: TerminalGridSize) => {
      void resizeTerminal({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          terminalId,
          cols: size.cols,
          rows: size.rows,
        },
      });
    },
    [props.environmentId, props.threadId, resizeTerminal, terminalId],
  );

  useEffect(() => {
    if (isRunning) {
      sendResize(lastGridSizeRef.current);
    }
  }, [isRunning, sendResize]);

  const handleInput = useCallback(
    (data: string) => {
      if (!isRunning) {
        return;
      }

      void writeTerminal({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          terminalId,
          data,
        },
      });
    },
    [isRunning, props.environmentId, props.threadId, terminalId, writeTerminal],
  );

  const handleResize = useCallback(
    (size: TerminalGridSize) => {
      const previousSize = lastGridSizeRef.current;
      if (size.cols === previousSize.cols && size.rows === previousSize.rows) {
        return;
      }

      lastGridSizeRef.current = size;
      if (!isRunning) {
        return;
      }

      sendResize(size);
    },
    [isRunning, sendResize],
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
