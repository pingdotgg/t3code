import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalOutputCursor,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
  getNativeTerminalHardwareKeyRevision,
  getNativeTerminalStreamingRevision,
  NATIVE_TERMINAL_STREAMING_REVISION,
  resolveNativeTerminalSurfaceView,
  type NativeTerminalSurfaceHandle,
} from "./nativeTerminalModule";
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

const NATIVE_COMMAND_RETRY_FRAMES = 8;

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isPendingNativeViewRegistration(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Unable to find the 'T3Terminal' view") ||
      (error.message.includes("Unable to find the class") &&
        error.message.includes("T3TerminalView view with tag")))
  );
}

interface TerminalSurfaceProps extends ViewProps {
  readonly terminalKey: string;
  readonly output: TerminalOutputState;
  readonly replayPaused?: boolean;
  /** True while the server has opened a replay it has not completed yet. */
  readonly replayPending?: boolean;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly autoFocus?: boolean;
  readonly keyboardFocusRequest?: number;
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
  const fontSize = props.fontSize ?? MOBILE_TYPOGRAPHY.label.fontSize;
  const inputRef = useRef<TextInput>(null);
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(themeId, themeAppearance);
  const statusLabel = props.isRunning
    ? "Native terminal unavailable. Using text fallback."
    : "Open terminal to start a shell.";
  const buffer = props.replayPaused ? "" : terminalOutputText(props.output);

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

export const TerminalSurface = memo(function TerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? MOBILE_TYPOGRAPHY.label.fontSize;
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(themeId, themeAppearance);
  const { onInput, onResize } = props;
  const NativeTerminalSurfaceView = resolveNativeTerminalSurfaceView();
  const hasNativeSurface = Boolean(NativeTerminalSurfaceView);
  const streamingRevision = getNativeTerminalStreamingRevision();
  const supportsStreaming =
    streamingRevision !== null && streamingRevision >= NATIVE_TERMINAL_STREAMING_REVISION;
  const themeConfig = buildGhosttyThemeConfig(theme);
  const nativeRef = useRef<NativeTerminalSurfaceHandle>(null);
  const nativeCommandQueueRef = useRef(Promise.resolve());
  const outputCursorRef = useRef<TerminalOutputCursor>(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const streamIdentityRef = useRef("");
  const deferredEmptyResetRef = useRef(false);
  const surfaceIdentity = `${props.terminalKey}:${fontSize}:${themeAppearance}:${themeConfig}`;
  // A failed native command rebuilds the surface once from the retained
  // snapshot; without that, an idle terminal would stay stale until new output.
  const [nativeRecoveryVersion, setNativeRecoveryVersion] = useState(0);
  const recoveredSurfaceIdentityRef = useRef<string | null>(null);
  const resetIdentity = `${surfaceIdentity}:${nativeRecoveryVersion}`;
  const legacyBuffer =
    supportsStreaming || props.replayPaused ? "" : terminalOutputText(props.output);

  useEffect(() => {
    terminalDebugLog("native:surface", {
      terminalKey: props.terminalKey,
      native: hasNativeSurface,
      // null = installed binary predates native hardware-key handling (rebuild needed).
      hardwareKeyRevision: getNativeTerminalHardwareKeyRevision(),
      retainedBytes: props.output.retainedBytes,
      isRunning: props.isRunning,
      streamingRevision,
    });
  }, [
    hasNativeSurface,
    props.isRunning,
    props.output.retainedBytes,
    props.terminalKey,
    streamingRevision,
  ]);
  useEffect(
    () => () => {
      streamIdentityRef.current = "";
    },
    [],
  );
  useEffect(() => {
    if (!supportsStreaming) return;
    const streamIdentity = props.replayPaused ? `${resetIdentity}:paused` : resetIdentity;
    const forceReset = streamIdentityRef.current !== streamIdentity;
    const update =
      forceReset || props.replayPaused
        ? {
            type: "reset" as const,
            data: props.replayPaused ? "" : terminalOutputText(props.output),
            cursor: {
              resetVersion: props.output.resetVersion,
              lastChunkId: props.output.latestChunkId,
            },
          }
        : readTerminalOutputUpdate(props.output, outputCursorRef.current);
    streamIdentityRef.current = streamIdentity;
    outputCursorRef.current = update.cursor;
    if (!forceReset && props.replayPaused) return;
    let commands: Array<{ type: "reset" | "write" | "writeReplay"; data: string }> =
      update.type === "reset"
        ? [{ type: "reset", data: update.data }]
        : update.type === "append"
          ? update.segments.map((segment) => ({
              type: segment.delivery === "replay" ? ("writeReplay" as const) : ("write" as const),
              data: segment.data,
            }))
          : [];
    if (
      !forceReset &&
      props.replayPending === true &&
      update.type === "reset" &&
      update.data.length === 0
    ) {
      // A replay in flight opens with an empty snapshot. Keep the last frame
      // on screen and fold the reset into the first replay chunk instead of
      // blanking the terminal while history streams in.
      deferredEmptyResetRef.current = true;
      commands = [];
    } else if (deferredEmptyResetRef.current) {
      const first = commands[0];
      if (first !== undefined) {
        deferredEmptyResetRef.current = false;
        if (first.type === "writeReplay") {
          commands = [{ type: "reset" as const, data: first.data }, ...commands.slice(1)];
        } else if (first.type === "write") {
          commands = [{ type: "reset" as const, data: "" }, ...commands];
        }
        // A reset command already supersedes the deferred one.
      } else if (props.replayPending !== true) {
        // The replay finished without producing content: the terminal really
        // is empty now, so apply the reset that was held back.
        deferredEmptyResetRef.current = false;
        commands = [{ type: "reset" as const, data: terminalOutputText(props.output) }];
      }
    }
    if (commands.length === 0) return;
    nativeCommandQueueRef.current = nativeCommandQueueRef.current
      .then(async () => {
        for (const pending of commands) {
          for (let attempt = 0; attempt <= NATIVE_COMMAND_RETRY_FRAMES; attempt += 1) {
            if (streamIdentityRef.current !== streamIdentity) return;
            const handle = nativeRef.current;
            const command = handle?.[pending.type];
            if (!command) {
              if (attempt < NATIVE_COMMAND_RETRY_FRAMES) {
                await nextAnimationFrame();
                continue;
              }
              throw new Error(`Native terminal does not support ${pending.type}`);
            }

            try {
              await command.call(handle, pending.data);
              break;
            } catch (error) {
              if (attempt < NATIVE_COMMAND_RETRY_FRAMES && isPendingNativeViewRegistration(error)) {
                await nextAnimationFrame();
                continue;
              }
              throw error;
            }
          }
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to update native terminal output", error);
        if (streamIdentityRef.current !== streamIdentity) return;
        // The next output update rebuilds the native surface from the retained
        // snapshot instead of continuing after a missing command.
        streamIdentityRef.current = "";
        if (recoveredSurfaceIdentityRef.current === surfaceIdentity) return;
        recoveredSurfaceIdentityRef.current = surfaceIdentity;
        setNativeRecoveryVersion((version) => version + 1);
      });
  }, [
    props.output,
    props.replayPaused,
    props.replayPending,
    resetIdentity,
    supportsStreaming,
    surfaceIdentity,
  ]);
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

  if (NativeTerminalSurfaceView) {
    return (
      <View style={props.style}>
        <NativeTerminalSurfaceView
          ref={nativeRef}
          appearanceScheme={themeAppearance}
          autoFocus={props.autoFocus ?? true}
          backgroundColor={theme.background}
          focusRequest={props.isRunning ? (props.keyboardFocusRequest ?? 0) : 0}
          foregroundColor={theme.foreground}
          mutedForegroundColor={theme.mutedForeground}
          terminalKey={props.terminalKey}
          initialBuffer={legacyBuffer}
          fontSize={fontSize}
          style={{ flex: 1 }}
          themeConfig={themeConfig}
          onInput={handleNativeInput}
          onResize={handleNativeResize}
        />
      </View>
    );
  }

  return <FallbackTerminalSurface {...props} fontSize={fontSize} theme={theme} />;
});
