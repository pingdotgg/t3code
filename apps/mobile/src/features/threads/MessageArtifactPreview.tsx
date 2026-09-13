import {
  createMessageArtifactHost,
  createSandboxedMessageArtifactDocument,
  loadMessageArtifactSource,
  messageArtifactAssetResource,
  messageArtifactFileName,
  messageArtifactMessageInjection,
  MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT,
  MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT,
  MESSAGE_ARTIFACT_MIN_FRAME_HEIGHT,
  MESSAGE_ARTIFACT_NAVIGATED_MESSAGE,
  MESSAGE_ARTIFACT_UNAVAILABLE_MESSAGE,
  readMessageArtifactMemory,
  rememberMessageArtifact,
  setMessageArtifactHeightStore,
  type MessageArtifactHost,
  type MessageArtifactHostContext,
  type MessageArtifactSource,
  type MessageArtifactStyleVariable,
} from "@t3tools/client-runtime/message-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { File, Paths } from "expo-file-system";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { resolveMarkdownFontSizes } from "../../lib/appearancePreferences";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type UniwindTheme = ReturnType<typeof useUniwindTheme>;

const CRASHED_MESSAGE = "The page stopped responding.";

// Heights outlive restarts so a reopened thread keeps its layout. The file sits in the cache
// directory, which the system may clear; the shared store ignores failures.
const heightsFile = () => new File(Paths.cache, "message-artifact-heights.json");
setMessageArtifactHeightStore({
  read: () => {
    const file = heightsFile();
    return file.exists ? file.textSync() : null;
  },
  write: (value) => {
    const file = heightsFile();
    if (!file.exists) file.create();
    file.write(value);
  },
});

/** The mobile palette has no info or success roles, so these follow the web defaults. */
const STATUS_TEXT_COLORS = {
  light: { "--color-text-info": "#1d4ed8", "--color-text-success": "#047857" },
  dark: { "--color-text-info": "#60a5fa", "--color-text-success": "#34d399" },
} as const;

/**
 * The WebView needs raw values, so this maps the MCP Apps theme variables to the mobile palette.
 * The code background is translucent; the page body is transparent over the card, so they match.
 */
function useArtifactHostContext(
  palette: UniwindTheme,
  maxHeight: number,
): MessageArtifactHostContext {
  const { appearance, themeAppearance } = useAppearancePreferences();
  const { baseFontSize } = appearance;
  return useMemo(() => {
    const fontSizes = resolveMarkdownFontSizes(baseFontSize);
    return {
      theme: themeAppearance,
      platform: "mobile",
      containerDimensions: { maxHeight },
      styles: {
        variables: {
          "--color-background-primary": palette["--color-md-code-bg"],
          "--color-background-secondary": palette["--color-subtle"],
          "--color-background-tertiary": palette["--color-subtle-strong"],
          "--color-background-inverse": palette["--color-foreground"],
          "--color-background-info": "rgba(59, 130, 246, 0.12)",
          "--color-background-success": "rgba(16, 185, 129, 0.12)",
          "--color-background-warning": palette["--color-warning"],
          "--color-background-danger": palette["--color-danger"],
          "--color-text-primary": palette["--color-foreground"],
          "--color-text-secondary": palette["--color-foreground-muted"],
          "--color-text-tertiary": palette["--color-foreground-tertiary"],
          "--color-text-inverse": palette["--color-card"],
          ...STATUS_TEXT_COLORS[themeAppearance],
          "--color-text-warning": palette["--color-warning-foreground"],
          "--color-text-danger": palette["--color-danger-foreground"],
          "--color-border-primary": palette["--color-border"],
          "--color-border-secondary": palette["--color-input-border"],
          "--color-border-danger": palette["--color-danger-border"],
          "--color-ring-primary": palette["--color-primary"],
          "--font-sans": "system-ui, sans-serif",
          "--font-mono": "ui-monospace, monospace",
          // Chat text follows the Appearance base size.
          "--font-text-sm-size": `${fontSizes.s}px`,
          "--font-text-md-size": `${fontSizes.m}px`,
          "--border-radius-sm": "4px",
          "--border-radius-md": "8px",
          "--border-radius-lg": "12px",
          "--border-radius-full": "9999px",
        } satisfies Record<MessageArtifactStyleVariable, string>,
      },
    };
  }, [baseFontSize, maxHeight, palette, themeAppearance]);
}

/** There is no click to check on mobile, so the user confirms every link a page asks to open. */
function confirmOpenLink(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Open link?",
      new URL(url).host,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: "Open",
          onPress: () => void tryOpenExternalUrl(url, "markdown-link").then(resolve),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function HeaderAction(props: {
  readonly label: string;
  readonly state: { readonly selected: boolean } | { readonly expanded: boolean };
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={props.state}
      hitSlop={6}
      className="min-h-8 justify-center rounded-md px-2 active:opacity-65"
      onPress={props.onPress}
    >
      <Text className="font-t3-medium text-xs text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

/** Shows a message's `t3-artifact` in place, in a WebView without files, storage, or navigation. */
export const MessageArtifactPreview = memo(function MessageArtifactPreview(props: {
  readonly environmentId: EnvironmentId;
  /** The text attachment holding the copy the server saved, or null until there is one. */
  readonly attachmentId: string | null;
  readonly path: string;
}) {
  const { attachmentId } = props;
  const fileName = messageArtifactFileName(props.path);
  const palette = useUniwindTheme();
  const [attempt, setAttempt] = useState(0);
  const [hidden, setHidden] = useState(
    () => attachmentId !== null && readMessageArtifactMemory(attachmentId)?.hidden === true,
  );
  const [showSource, setShowSource] = useState(false);

  return (
    <View
      accessibilityLabel={fileName}
      className="my-3 min-w-0 self-stretch overflow-hidden rounded-lg border"
      style={{
        backgroundColor: palette["--color-md-code-bg"],
        borderColor: palette["--color-border"],
      }}
    >
      <View
        className="min-h-9 flex-row items-center justify-between gap-2 py-0.5 pr-1 pl-3.5"
        style={
          hidden
            ? undefined
            : { borderBottomWidth: 1, borderBottomColor: palette["--color-border"] }
        }
      >
        <Text className="flex-1 font-mono text-xs opacity-70" numberOfLines={1}>
          {fileName}
        </Text>
        {attachmentId === null ? null : (
          <>
            {hidden ? null : (
              <HeaderAction
                label={showSource ? "Page" : "Source"}
                state={{ selected: showSource }}
                onPress={() => setShowSource((value) => !value)}
              />
            )}
            <HeaderAction
              label={hidden ? "Show" : "Hide"}
              state={{ expanded: !hidden }}
              onPress={() => {
                setHidden(!hidden);
                rememberMessageArtifact(attachmentId, { hidden: !hidden });
              }}
            />
          </>
        )}
      </View>
      {attachmentId === null ? (
        <Text className="px-3.5 py-2.5 font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {props.path}
        </Text>
      ) : hidden ? null : (
        <MessageArtifactBody
          key={attempt}
          attachmentId={attachmentId}
          environmentId={props.environmentId}
          fileName={fileName}
          palette={palette}
          showSource={showSource}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
    </View>
  );
});

function MessageArtifactBody(props: {
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly palette: UniwindTheme;
  readonly showSource: boolean;
  readonly onRetry: () => void;
}) {
  const { attachmentId, environmentId, fileName } = props;
  const resource = useMemo(
    () => messageArtifactAssetResource(attachmentId, fileName),
    [attachmentId, fileName],
  );
  const asset = useAssetUrlState(environmentId, resource);
  const refreshUrl = useRefreshAssetUrl(environmentId, resource);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const url = asset._tag === "Success" ? asset.url : null;
  const [source, setSource] = useState<MessageArtifactSource | null>(() => {
    const remembered = readMessageArtifactMemory(attachmentId)?.source;
    return remembered === undefined ? null : { _tag: "Ready", source: remembered };
  });
  const [stopped, setStopped] = useState<string | null>(null);
  // A frame taller than most of the screen would capture the thread's scrolling.
  const windowHeight = useWindowDimensions().height;
  const maxHeight = Math.max(
    MESSAGE_ARTIFACT_MIN_FRAME_HEIGHT,
    Math.min(MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT, Math.round(windowHeight * 0.6)),
  );
  const urlRef = useRef(url);
  const loadedRef = useRef(source !== null);

  useEffect(() => {
    urlRef.current = url;
  });

  // Fetch once, then reuse the remembered copy on remounts. The URL drops out on every reconnect
  // and renews in the background; reloading the page then would discard the user's work.
  const hasUrl = url !== null;
  useEffect(() => {
    const documentUrl = urlRef.current;
    if (!hasUrl || documentUrl === null || loadedRef.current) return;
    const abortController = new AbortController();
    void loadMessageArtifactSource(documentUrl, abortController.signal).then((loaded) => {
      if (abortController.signal.aborted) return;
      loadedRef.current = true;
      if (loaded._tag === "Ready") rememberMessageArtifact(attachmentId, { source: loaded.source });
      setSource(loaded);
    });
    return () => abortController.abort();
  }, [attachmentId, hasUrl]);

  const disconnected =
    source === null && asset._tag === "Failure" && asset.reason === "disconnected";
  const failure =
    stopped ??
    (source?._tag === "Failure"
      ? source.message
      : disconnected
        ? "Reconnect to load this artifact."
        : source === null && asset._tag === "Failure"
          ? MESSAGE_ARTIFACT_UNAVAILABLE_MESSAGE
          : null);

  if (failure !== null) {
    return (
      <View className="items-center gap-2 px-3.5 py-4">
        <Text className="text-center text-sm text-foreground-muted">{failure}</Text>
        <Pressable
          accessibilityRole="button"
          className="rounded-full bg-subtle px-3 py-1.5 active:opacity-65"
          onPress={() => {
            if (disconnected) void retryEnvironment(environmentId);
            // Retrying renews the signed URL, then remounts with a fresh fetch.
            void refreshUrl()
              .catch(() => null)
              .finally(props.onRetry);
          }}
        >
          <Text className="font-t3-medium text-xs text-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  }

  const height = Math.min(
    readMessageArtifactMemory(attachmentId)?.height ?? MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT,
    maxHeight,
  );
  if (source?._tag !== "Ready") {
    return (
      <View
        accessibilityState={{ busy: true }}
        className="items-center justify-center"
        style={{ height }}
      >
        <Text className="text-xs text-foreground-muted">Loading artifact…</Text>
      </View>
    );
  }

  if (props.showSource) {
    return (
      <ScrollView
        nestedScrollEnabled
        directionalLockEnabled
        style={{ maxHeight }}
        contentContainerClassName="px-3.5 py-3"
      >
        <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
          {source.source}
        </Text>
      </ScrollView>
    );
  }

  return (
    <MessageArtifactWebView
      artifactKey={attachmentId}
      maxHeight={maxHeight}
      palette={props.palette}
      source={source.source}
      onStop={setStopped}
    />
  );
}

/** Mounts with a document built from the latest remembered state, so toggling source keeps work. */
function MessageArtifactWebView(props: {
  readonly artifactKey: string;
  readonly maxHeight: number;
  readonly palette: UniwindTheme;
  readonly source: string;
  readonly onStop: (message: string) => void;
}) {
  const { artifactKey, maxHeight, onStop } = props;
  const context = useArtifactHostContext(props.palette, maxHeight);
  const contextRef = useRef(context);
  const webViewRef = useRef<WebView>(null);
  const hostRef = useRef<MessageArtifactHost | null>(null);
  const [contentHeight, setContentHeight] = useState(
    () => readMessageArtifactMemory(artifactKey)?.height ?? MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT,
  );
  const [html] = useState(() =>
    createSandboxedMessageArtifactDocument(props.source, {
      context,
      state: readMessageArtifactMemory(artifactKey)?.state,
    }),
  );

  useEffect(() => {
    contextRef.current = context;
  });

  // Created in the mount commit, before JavaScript can handle the page's first `ui/initialize`.
  useLayoutEffect(() => {
    const host = createMessageArtifactHost({
      key: artifactKey,
      context: contextRef.current,
      send: (message) =>
        webViewRef.current?.injectJavaScript(messageArtifactMessageInjection(message)),
      onHeight: (height) => {
        setContentHeight(height);
        rememberMessageArtifact(artifactKey, { height });
      },
      openLink: confirmOpenLink,
      onUnload: () => onStop(MESSAGE_ARTIFACT_NAVIGATED_MESSAGE),
    });
    hostRef.current = host;
    return () => {
      hostRef.current = null;
    };
  }, [artifactKey, onStop]);

  useEffect(() => {
    hostRef.current?.updateContext(context);
  }, [context]);

  const scrolls = contentHeight > maxHeight;
  return (
    <View style={{ height: Math.min(contentHeight, maxHeight) }}>
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: "about:blank" }}
        // Any origin passes here so refused navigations are not handed to the operating system.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:")}
        // Android allows a navigation when the check above is slow; stop the artifact if one lands.
        onLoadStart={(event) => {
          if (!event.nativeEvent.url.startsWith("about:"))
            onStop(MESSAGE_ARTIFACT_NAVIGATED_MESSAGE);
        }}
        onContentProcessDidTerminate={() => onStop(CRASHED_MESSAGE)}
        onRenderProcessGone={() => onStop(CRASHED_MESSAGE)}
        onOpenWindow={() => undefined}
        javaScriptEnabled
        domStorageEnabled={false}
        incognito
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        onMessage={(event) => hostRef.current?.receive(event.nativeEvent.data)}
        scrollEnabled={scrolls}
        nestedScrollEnabled={scrolls}
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}
