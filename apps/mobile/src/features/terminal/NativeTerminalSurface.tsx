import { memo, useCallback, useEffect } from "react";
import {
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type ViewProps,
  useColorScheme,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { resolveNativeTerminalSurfaceView } from "./nativeTerminalModule";
import {
  buildGhosttyThemeConfig,
  getPierreTerminalTheme,
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
  readonly buffer: string;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly theme?: TerminalTheme;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
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
  const fontSize = props.fontSize ?? 12;
  const appearanceScheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = props.theme ?? getPierreTerminalTheme(appearanceScheme);
  const statusLabel = props.isRunning
    ? "Native terminal unavailable. Using text fallback."
    : "Open terminal to start a shell.";

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    props.onResize(estimateGridSize({ width, height, fontSize }));
  };

  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: theme.background,
          borderRadius: 8,
          overflow: "hidden",
        },
        props.style,
      ]}
      onLayout={handleLayout}
    >
      <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text
          style={{
            color: theme.mutedForeground,
            fontSize: 11,
            paddingBottom: 8,
          }}
        >
          {statusLabel}
        </Text>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
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
            {props.buffer || "$ "}
          </Text>
        </ScrollView>
      </View>
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.border,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          padding: 8,
        }}
      >
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          editable={props.isRunning}
          placeholder="type and press return"
          placeholderTextColor={theme.mutedForeground}
          returnKeyType="send"
          style={{
            color: theme.foreground,
            flex: 1,
            fontFamily: "Menlo",
            fontSize: 13,
            padding: 0,
          }}
          onSubmitEditing={(event) => {
            const text = event.nativeEvent.text;
            if (text.length > 0) {
              props.onInput(`${text}\n`);
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
          <Text
            style={{
              color: theme.foreground,
              fontFamily: "DMSans_700Bold",
              fontSize: 11,
            }}
          >
            Ctrl-C
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

export const TerminalSurface = memo(function TerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? 12;
  const appearanceScheme = useColorScheme() === "light" ? "light" : "dark";
  const theme = props.theme ?? getPierreTerminalTheme(appearanceScheme);
  const { onInput, onResize } = props;
  const NativeTerminalSurfaceView = resolveNativeTerminalSurfaceView();
  const hasNativeSurface = Boolean(NativeTerminalSurfaceView);

  useEffect(() => {
    terminalDebugLog("native:surface", {
      terminalKey: props.terminalKey,
      native: hasNativeSurface,
      bufferLen: props.buffer.length,
      isRunning: props.isRunning,
    });
  }, [hasNativeSurface, props.buffer.length, props.isRunning, props.terminalKey]);
  const handleNativeInput = useCallback(
    (event: NativeSyntheticEvent<TerminalInputEvent>) => {
      onInput(event.nativeEvent.data);
    },
    [onInput],
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

  if (NativeTerminalSurfaceView) {
    return (
      <NativeTerminalSurfaceView
        {...props}
        appearanceScheme={appearanceScheme}
        backgroundColor={theme.background}
        foregroundColor={theme.foreground}
        mutedForegroundColor={theme.mutedForeground}
        terminalKey={props.terminalKey}
        initialBuffer={props.buffer}
        fontSize={fontSize}
        themeConfig={buildGhosttyThemeConfig(theme)}
        onInput={handleNativeInput}
        onResize={handleNativeResize}
      />
    );
  }

  return <FallbackTerminalSurface {...props} fontSize={fontSize} theme={theme} />;
});
