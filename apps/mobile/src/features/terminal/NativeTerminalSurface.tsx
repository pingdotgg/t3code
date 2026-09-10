import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  getNativeTerminalBufferStreamRevision,
  getNativeTerminalHardwareKeyRevision,
  resolveNativeTerminalSurfaceView,
  type NativeTerminalSurfaceProps,
} from "./nativeTerminalModule";
import {
  IDLE_TERMINAL_BUFFER_WRITE,
  mergeTerminalBufferWrite,
  type TerminalBufferWrite,
} from "./terminalBufferWrite";
import {
  buildGhosttyThemeConfig,
  getMobileTerminalTheme,
  type TerminalTheme,
} from "./terminalTheme";
import { terminalDebugLog } from "./terminalDebugLog";

interface TerminalInputEvent {
  readonly data: string;
}

interface TerminalResizeEvent {
  readonly cols: number;
  readonly rows: number;
}

interface TerminalSurfaceProps extends ViewProps {
  readonly terminalKey: string;
  readonly output: TerminalOutputState;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly autoFocus?: boolean;
  readonly keyboardFocusRequest?: number;
  readonly theme?: TerminalTheme;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
}

/**
 * Track the output the native surface has not consumed yet.
 *
 * The native side owns the rendered grid, so it only ever needs the bytes it
 * has not seen. Materializing the whole retained buffer on every output event
 * instead made the native view rebuild its terminal once the retention window
 * started rolling, which froze the UI thread.
 *
 * 原生侧自己持有渲染结果，只需要拿到还没消费的字节。之前每次输出都把整个保留
 * 缓冲区物化一遍，一旦保留窗口开始滚动，原生就会不断重建终端，把 UI 线程卡死。
 */
function useTerminalBufferWrite(output: TerminalOutputState): TerminalBufferWrite {
  const [write, setWrite] = useState<TerminalBufferWrite>(IDLE_TERMINAL_BUFFER_WRITE);
  const cursorRef = useRef(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const committedSeqRef = useRef(IDLE_TERMINAL_BUFFER_WRITE.seq);

  useEffect(() => {
    const update = readTerminalOutputUpdate(output, cursorRef.current);
    cursorRef.current = update.cursor;
    if (update.type === "none") {
      return;
    }
    setWrite((pending) =>
      mergeTerminalBufferWrite({
        pending,
        committedSeq: committedSeqRef.current,
        update,
      }),
    );
  }, [output]);

  // A rendered write has reached the native view, so the next update starts a
  // new sequence instead of merging into it.
  //
  // 已渲染的写入意味着原生已收到，下一次更新另起序号而不是继续合并。
  useEffect(() => {
    committedSeqRef.current = write.seq;
  }, [write]);

  return write;
}

function estimateGridSize(input: {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}): { readonly cols: number; readonly rows: number } {
  const cellWidth = input.fontSize * 0.62;
  const cellHeight = input.fontSize * 1.35;
  return {
    cols: Math.max(20, Math.min(400, Math.floor(input.width / cellWidth))),
    rows: Math.max(5, Math.min(200, Math.floor(input.height / cellHeight))),
  };
}

const FallbackTerminalSurface = memo(function FallbackTerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? MOBILE_TYPOGRAPHY.label.fontSize;
  const inputRef = useRef<TextInput>(null);
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(themeId, themeAppearance);
  // Only the text fallback renders history itself, so it is the one place that
  // still pays for materializing the retained buffer.
  //
  // 只有文本兜底视图需要自己渲染历史，所以物化保留缓冲区的开销只留在这里。
  const buffer = useMemo(() => terminalOutputText(props.output), [props.output]);
  const statusLabel = props.isRunning
    ? "Native terminal unavailable. Using text fallback."
    : "Open terminal to start a shell.";

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    props.onResize(estimateGridSize({ width, height, fontSize }));
  };

  useEffect(() => {
    if ((props.keyboardFocusRequest ?? 0) > 0) {
      inputRef.current?.blur();
      const focusFrame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(focusFrame);
    }

    return undefined;
  }, [props.keyboardFocusRequest]);

  return (
    <View
      className="flex-1"
      style={[
        {
          backgroundColor: theme.background,
          borderRadius: 8,
          overflow: "hidden",
        },
        props.style,
      ]}
      onLayout={handleLayout}
    >
      <View className="flex-1 px-2.5 py-2">
        <Text
          className="pb-2 text-2xs"
          style={{
            color: theme.mutedForeground,
          }}
        >
          {statusLabel}
        </Text>
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-3"
          showsVerticalScrollIndicator={false}
        >
          <Text
            selectable
            style={{
              color: theme.foreground,
              fontFamily: "Menlo",
              fontSize,
              lineHeight: Math.round(fontSize * 1.35),
            }}
          >
            {buffer || "$ "}
          </Text>
        </ScrollView>
      </View>
      <View
        className="flex-row items-center gap-2 border-t p-2"
        style={{
          borderTopColor: theme.border,
        }}
      >
        <TextInput
          ref={inputRef}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          editable={props.isRunning}
          placeholder="type and press return"
          placeholderTextColor={theme.mutedForeground}
          returnKeyType="send"
          className="text-sm"
          style={{
            color: theme.foreground,
            flex: 1,
            fontFamily: "Menlo",
            padding: 0,
          }}
          onSubmitEditing={(event) => {
            const text = event.nativeEvent.text;
            if (text.length > 0) {
              // Terminal Enter is CR. LF is Ctrl+J and raw-mode TUIs can treat it as J.
              props.onInput(`${text}\r`);
            }
          }}
        />
        <Pressable
          disabled={!props.isRunning}
          style={({ pressed }) => ({
            opacity: !props.isRunning ? 0.35 : pressed ? 0.65 : 1,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: theme.border,
          })}
          onPress={() => props.onInput("\u0003")}
        >
          <Text className="text-2xs font-t3-bold" style={{ color: theme.foreground }}>
            Ctrl-C
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const NativeTerminalSurfaceHost = memo(function NativeTerminalSurfaceHost(
  props: TerminalSurfaceProps & {
    readonly fontSize: number;
    readonly theme: TerminalTheme;
    readonly NativeView: ComponentType<NativeTerminalSurfaceProps>;
  },
) {
  const { NativeView, onInput, onResize } = props;
  const { themeAppearance } = useAppearancePreferences();
  const write = useTerminalBufferWrite(props.output);

  useEffect(() => {
    terminalDebugLog("native:surface", {
      terminalKey: props.terminalKey,
      native: true,
      // null = installed binary predates native hardware-key handling (rebuild needed).
      hardwareKeyRevision: getNativeTerminalHardwareKeyRevision(),
      // null = installed binary predates incremental writes (rebuild needed).
      bufferStreamRevision: getNativeTerminalBufferStreamRevision(),
      retainedBytes: props.output.retainedBytes,
      isRunning: props.isRunning,
    });
  }, [props.isRunning, props.output.retainedBytes, props.terminalKey]);

  const handleNativeInput = useCallback(
    (event: NativeSyntheticEvent<TerminalInputEvent>) => {
      if (!props.isRunning) {
        return;
      }
      terminalDebugLog("native:onInput", {
        codes: Array.from(event.nativeEvent.data, (char) => char.codePointAt(0)),
      });
      onInput(event.nativeEvent.data);
    },
    [onInput, props.isRunning],
  );
  const handleNativeResize = useCallback(
    (event: NativeSyntheticEvent<TerminalResizeEvent>) => {
      onResize({
        cols: event.nativeEvent.cols,
        rows: event.nativeEvent.rows,
      });
    },
    [onResize],
  );

  return (
    <View style={props.style}>
      <NativeView
        appearanceScheme={themeAppearance}
        autoFocus={props.autoFocus ?? true}
        backgroundColor={props.theme.background}
        bufferWrite={write}
        focusRequest={props.isRunning ? (props.keyboardFocusRequest ?? 0) : 0}
        foregroundColor={props.theme.foreground}
        mutedForegroundColor={props.theme.mutedForeground}
        terminalKey={props.terminalKey}
        fontSize={props.fontSize}
        style={{ flex: 1 }}
        themeConfig={buildGhosttyThemeConfig(props.theme)}
        onInput={handleNativeInput}
        onResize={handleNativeResize}
      />
    </View>
  );
});

export const TerminalSurface = memo(function TerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? MOBILE_TYPOGRAPHY.label.fontSize;
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(themeId, themeAppearance);
  const NativeTerminalSurfaceView = resolveNativeTerminalSurfaceView();

  if (NativeTerminalSurfaceView) {
    return (
      // Remount on terminal identity so a switched session starts from a fresh
      // write sequence instead of streaming into the previous terminal's grid.
      //
      // 终端身份变化时整体重挂载，切换会话后从新的写入序号开始，
      // 避免把新内容流进上一个终端的网格。
      <NativeTerminalSurfaceHost
        {...props}
        key={props.terminalKey}
        NativeView={NativeTerminalSurfaceView}
        fontSize={fontSize}
        theme={theme}
      />
    );
  }

  return <FallbackTerminalSurface {...props} fontSize={fontSize} theme={theme} />;
});
