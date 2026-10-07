import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  mcpResourceBytes,
  type McpAppCallToolResult,
  type McpAppHost,
  type McpAppHostContext,
} from "@t3tools/client-runtime/mcp-apps";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId } from "@t3tools/contracts";
import {
  mcpAppAllowAttribute,
  mcpAppFileName,
  mcpAppReferencesEqual,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import * as Predicate from "effect/Predicate";
import Constants from "expo-constants";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { shareGeneratedAttachment } from "../../lib/attachmentDownload";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { useAssetUrlState } from "../../state/assets";
import { useThreadShell } from "../../state/entities";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** The feed reserves a fixed box for an app; a taller app scrolls inside it. */
const MCP_APP_ROW_HEIGHT = 420;
const ROW_BOTTOM_MARGIN = 8;

export function mcpAppRowHeight() {
  return MCP_APP_ROW_HEIGHT + ROW_BOTTOM_MARGIN;
}

// The WebView loads a tiny outer page that hosts the app in a real
// opaque-origin iframe, as web does, so the app's `window.parent` and the
// `event.source` of host replies are a real window, which the MCP Apps SDK
// requires. The outer page only relays: app → React Native, and host
// replies (injected as `__t3McpAppReceive(...)`) → app.
//
// Android exposes `ReactNativeWebView` to every frame, so a frame nested in
// the app could post to React Native directly. The outer page therefore wraps
// what it relays with a secret only it holds, and React Native drops anything
// else. The bridge belongs to the captured document: once the app frame loads
// a second time (it navigated itself), the outer page stops relaying and says
// so, rather than letting a page T3 never served pose as the app. This is not
// a confidentiality boundary: a frame can always navigate itself, so the app
// could carry anything it read out in a URL either way.
function outerDocument(src: string, allow: string, secret: string) {
  const attribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="allow-scripts allow-forms" allow="${attribute(allow)}"></iframe>
<script>(function(){var frame=document.getElementById("app"),secret=${JSON.stringify(secret)},loads=0,live=true;
var send=function(m){window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,message:m}));};
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;send({t3:"navigated"});}});
window.addEventListener("message",function(e){if(live&&e.source===frame.contentWindow)send(e.data);});
window.__t3McpAppReceive=function(m){live&&frame.contentWindow&&frame.contentWindow.postMessage(m,"*");};
frame.src=${JSON.stringify(src).replace(/</g, "\\u003c")};})();</script></body></html>`;
}

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

const confirm = (title: string, message: string, action: string) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ],
      // Android dismisses an open alert when the next one shows; a dismissed
      // request is declined rather than left holding an in-flight slot.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

/** Largest file an app may hand the user through `ui/download-file`. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * A captured MCP App, hosted in a WebView over the MCP Apps bridge: inline as
 * a fixed row of the thread feed, or full screen in its own modal screen. A
 * WebView cannot move between the two without reloading, so each is its own
 * view of the app: the inline one is torn down before full screen opens, and
 * comes back when it closes.
 */
export function ThreadMcpApp(props: {
  readonly environmentId: EnvironmentId;
  /** The thread that produced the app, which its requests run against. */
  readonly threadId: ThreadId;
  /** The thread on screen, which approved app messages are sent to. */
  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
  readonly app: McpAppReference;
  readonly width: number;
  /** Full screen fills its screen; inline is the feed's fixed row. */
  readonly displayMode?: "inline" | "fullscreen";
  /** Full screen only: leaves it, back to the inline row. */
  readonly onExitFullscreen?: () => void;
  /** Full screen only: the screen's height, which the app is told it fills. */
  readonly height?: number;
}) {
  // One reference per app: a new object with the same content (a refetch, a
  // rerender) must not rebuild the host of a document that is already live.
  const [app, setApp] = useState(props.app);
  if (!mcpAppReferencesEqual(app, props.app)) setApp(props.app);
  const fullscreen = props.displayMode === "fullscreen";
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // The app asked to be closed; the row falls back to a note that brings it back.
  const [closed, setClosed] = useState(false);
  // Full screen is a separate view of the app, so the inline one steps aside
  // (and is torn down) while it is open, and comes back when the thread is
  // shown again.
  const [presentedFullscreen, setPresentedFullscreen] = useState(false);
  // Counts the documents this row has shown on purpose (back from full screen,
  // or reopened after closing); each gets its own view and host.
  const [documentKey, setDocumentKeyState] = useState(0);

  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: app.attachmentId,
      fileName: mcpAppFileName(app),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [app],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  // The view keeps its first URL: a re-minted one would reload the app.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [loaded, setLoaded] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);
  // Bumped when the OS reclaims the web process: a fresh view, document and
  // host, so the reloaded app is initialized and replayed again. Once only, so
  // an app that keeps crashing its process is not reloaded forever.
  const [generation, setGeneration] = useState(0);
  const [crashed, setCrashed] = useState(false);
  const restart = () => {
    if (generation > 0) {
      setCrashed(true);
      return;
    }
    setLoaded(false);
    // The first URL's token may have expired by now; the asset query keeps
    // a refreshed one, which this new view can load.
    if (asset._tag === "Success") setUri(asset.url);
    setGeneration(1);
  };
  // Minted per view, so only this view's outer page can speak for its app.
  const [secret] = useState(uuidv4);
  // A new document starts loading, is not yet one that navigated away, and
  // loads the asset query's current URL: the first one's token may be gone.
  const setDocumentKey = (next: (value: number) => number) => {
    setLoaded(false);
    setNavigatedAway(false);
    if (asset._tag === "Success") setUri(asset.url);
    setDocumentKeyState(next);
  };
  // Back from full screen: the thread shows a fresh inline view of the app.
  // The listener reads the latest helper, whose URL comes from this render.
  const openNewDocument = useRef(setDocumentKey);
  useEffect(() => {
    openNewDocument.current = setDocumentKey;
  });
  useEffect(() => {
    if (!presentedFullscreen) return;
    return navigation.addListener("focus", () => {
      openNewDocument.current((value) => value + 1);
      setPresentedFullscreen(false);
    });
  }, [navigation, presentedFullscreen]);

  // The feed omits tool input and output; the app needs both.
  const detail = useEnvironmentQuery(
    orchestrationEnvironment.turnItem({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId, revision: props.revision },
    }),
  );
  const storedItem = detail.data?.item;
  const toolCall = useMemo(() => {
    if (storedItem?.type !== "dynamic_tool") return undefined;
    const output = storedItem.output as { readonly result?: unknown } | undefined;
    return {
      arguments: storedItem.input,
      result: output?.result as McpAppCallToolResult | undefined,
    };
  }, [storedItem]);

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });
  // The tool's definition, which the app receives as `toolInfo` at initialize.
  const [toolDefinition, setToolDefinition] = useState<unknown>(undefined);
  // Read by the host on every message, so it always sees current values
  // without being rebuilt (which would drop the app's session).
  // The approval or question the agent waits on renders on this thread, and a
  // full-screen app would cover it.
  const conversation = useThreadShell(
    scopeThreadRef(props.environmentId, props.conversationThreadId),
  );
  const awaitingUser =
    conversation?.hasPendingApprovals === true || conversation?.hasPendingUserInput === true;
  const live = {
    awaitingUser,
    theme,
    props,
    callTool,
    toolInfo,
    readResource,
    updateModelContext,
    insets,
    toolDefinition,
    navigation,
  };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });
  useEffect(() => {
    let cancelled = false;
    void latest.current
      .toolInfo({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
      })
      .then((info) => {
        if (!cancelled && info._tag === "Success" && info.value.tool !== undefined) {
          setToolDefinition(info.value.tool);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.threadId, props.itemId, app.tool]);
  const webView = useRef<WebView<object>>(null);
  const hostRef = useRef<McpAppHost | null>(null);

  // One host per loaded document.
  useEffect(() => {
    if (uri === null) return;
    const scope = () => {
      const { environmentId, threadId, itemId } = latest.current.props;
      return { environmentId, input: { threadId, itemId } };
    };
    const hostContext = (): McpAppHostContext => {
      const current = latest.current;
      const isFullscreen = current.props.displayMode === "fullscreen";
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        displayMode: isFullscreen ? "fullscreen" : "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        // Both are fixed boxes, so the app is told its exact size.
        containerDimensions: {
          width: current.props.width,
          height: isFullscreen ? (current.props.height ?? MCP_APP_ROW_HEIGHT) : MCP_APP_ROW_HEIGHT,
        },
        platform: "mobile",
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: `t3-code/${Constants.expoConfig?.version ?? "0.0.0"}`,
        deviceCapabilities: { touch: true, hover: false },
        // The full-screen modal keeps the top and bottom insets for its
        // header and the home indicator; only the sides reach the app.
        safeAreaInsets: isFullscreen
          ? { top: 0, right: current.insets.right, bottom: 0, left: current.insets.left }
          : { top: 0, right: 0, bottom: 0, left: 0 },
        ...(current.toolDefinition === undefined
          ? {}
          : { toolInfo: { tool: current.toolDefinition } }),
      };
    };
    const next = makeMcpAppHost({
      app,
      hostVersion: Constants.expoConfig?.version ?? "0.0.0",
      post: (message) =>
        webView.current?.injectJavaScript(
          `window.__t3McpAppReceive&&window.__t3McpAppReceive(${JSON.stringify(message)});true;`,
        ),
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const { environmentId, input } = scope();
        const info = await latest.current.toolInfo({ environmentId, input: { ...input, name } });
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
        if (
          !info.value.readOnly &&
          !(await confirm(
            `Allow ${app.server} to run ${info.value.title ?? name}?`,
            JSON.stringify(args, null, 2),
            "Allow",
          ))
        ) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        const result = await latest.current.callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri: resourceUri }) => {
        const { environmentId, input } = scope();
        const result = await latest.current.readResource({
          environmentId,
          input: { ...input, uri: resourceUri },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        // A WebView cannot tell whether the reader just tapped the app, so it
        // asks, rather than letting an app leave T3 on a timer.
        if (!(await confirm(`Open a link from ${app.server}?`, url, "Open"))) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        if (!(await tryOpenExternalUrl(url, "mcp-app"))) {
          throw new McpAppHostRefusal("The link could not be opened.");
        }
      },
      sendMessage: async (text) => {
        if (!(await confirm(`Send this message from ${app.server}?`, text, "Send"))) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        // Through the outbox like a typed message, so it survives a dropped
        // connection; the thread's own settings fill in when it sends.
        await enqueueThreadOutboxMessage({
          environmentId: latest.current.props.environmentId,
          threadId: latest.current.props.conversationThreadId,
          messageId: MessageId.make(uuidv4()),
          commandId: CommandId.make(uuidv4()),
          text,
          attachments: [],
          dispatchMode: "queue",
          createdAt: new Date().toISOString(),
        });
      },
      updateModelContext: async (context) => {
        const { environmentId, input } = scope();
        const result = await latest.current.updateModelContext({
          environmentId,
          input: {
            ...input,
            ...context,
            conversationThreadId: latest.current.props.conversationThreadId,
          },
        });
        if (result._tag !== "Success") throw commandFailure(result);
      },
      requestDisplayMode: async (mode) => {
        const current = latest.current.props;
        // Full screen would cover the approval or question the agent waits
        // on, or a screen the user moved to.
        if (
          mode === "fullscreen" &&
          (latest.current.awaitingUser || !latest.current.navigation.isFocused())
        ) {
          return current.displayMode ?? "inline";
        }
        if (mode === "fullscreen" && current.displayMode !== "fullscreen") {
          // The inline view is torn down by the switch (this row unmounts
          // while the modal covers it); the modal opens a fresh view.
          // The inline view steps aside for the modal; it gets its teardown first.
          await hostRef.current?.teardown();
          // The wait may have let an approval arrive, or the user moved to
          // another screen; either way the view reloads inline.
          if (latest.current.awaitingUser || !latest.current.navigation.isFocused()) {
            openNewDocument.current((value) => value + 1);
            return "inline";
          }
          setPresentedFullscreen(true);
          latest.current.navigation.navigate("ThreadMcpApp", {
            environmentId: String(current.environmentId),
            threadId: String(current.threadId),
            conversationThreadId: String(current.conversationThreadId),
            itemId: String(current.itemId),
            revision: current.revision,
          });
          return "fullscreen";
        }
        if (mode === "inline" && current.displayMode === "fullscreen") {
          await hostRef.current?.teardown();
          current.onExitFullscreen?.();
          return "inline";
        }
        return current.displayMode ?? "inline";
      },
      downloadFile: async (files) => {
        const names = files.map((file) => file.name).join(", ");
        if (!(await confirm(`Save a file from ${app.server}?`, names, "Save"))) {
          throw new McpAppHostRefusal("Declined by the user.");
        }
        for (const file of files) {
          // A linked file is read from the app's own server, like its other reads.
          let bytes: Uint8Array | undefined;
          let mimeType = file.mimeType ?? "application/octet-stream";
          if (file._tag === "embedded") {
            bytes = file.bytes;
          } else {
            const { environmentId, input } = scope();
            const read = await latest.current.readResource({
              environmentId,
              input: { ...input, uri: file.uri },
            });
            if (read._tag !== "Success") throw commandFailure(read);
            const content = read.value.contents[0];
            bytes = mcpResourceBytes(content);
            const declared = (content as { readonly mimeType?: unknown } | undefined)?.mimeType;
            if (typeof declared === "string") mimeType = declared;
          }
          if (bytes === undefined) throw new McpAppHostRefusal(`${file.name} has no contents.`);
          if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
            throw new McpAppHostRefusal(`${file.name} is too large to save.`);
          }
          const shared = await shareGeneratedAttachment({
            bytes,
            attachment: { name: file.name, mimeType },
            signal: new AbortController().signal,
          });
          if (!shared) throw new McpAppHostRefusal("Sharing is not available on this device.");
        }
      },
      onRequestTeardown: () => {
        const current = latest.current.props;
        if (current.displayMode === "fullscreen") {
          void hostRef.current?.teardown().then(() => current.onExitFullscreen?.());
        } else {
          void hostRef.current?.teardown().then(() => setClosed(true));
        }
      },
      // Both modes are fixed boxes, so the app's own height only decides
      // whether it scrolls inside one.
      onSizeChanged: () => undefined,
    });
    hostRef.current = next;
    return () => {
      // An unmount cannot wait: the request goes out before the view does.
      void next.teardown();
      hostRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A restarted view needs a new host.
  }, [uri, app, generation, documentKey]);

  // The host reads the context through `latest`; these only say when to resend.
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, props.width, props.height, insets, toolDefinition]);
  // A new document gets a new host, which needs the call again.
  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document needs the call.
  }, [toolCall, uri, generation, documentKey]);

  const source = useMemo(
    () =>
      uri === null
        ? null
        : { html: outerDocument(uri, mcpAppAllowAttribute(app.permissions), secret) },
    [uri, app.permissions, secret],
  );

  if (presentedFullscreen) {
    return (
      <View
        style={{ height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }}
        className="items-center justify-center rounded-lg border border-border"
      >
        <Text className="text-sm text-foreground-muted">
          The {app.server} app is open full screen
        </Text>
      </View>
    );
  }

  if (closed) {
    return (
      <View
        style={{ height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }}
        className="items-center justify-center gap-2 rounded-lg border border-border"
      >
        <Text className="text-sm text-foreground-muted">The {app.server} app was closed</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDocumentKey((value) => value + 1);
            setClosed(false);
          }}
        >
          <Text className="text-sm text-foreground">Show app</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={
        fullscreen ? { flex: 1 } : { height: MCP_APP_ROW_HEIGHT, marginBottom: ROW_BOTTOM_MARGIN }
      }
    >
      {navigatedAway ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">
            The {app.server} app left its page and was stopped
          </Text>
        </View>
      ) : uri !== null && !crashed ? (
        <WebView<object>
          key={`${documentKey}:${generation}`}
          ref={webView}
          onContentProcessDidTerminate={restart}
          onRenderProcessGone={restart}
          source={source!}
          accessibilityLabel={`${app.server} app`}
          style={{ flex: 1, backgroundColor: "transparent" }}
          nestedScrollEnabled
          originWhitelist={["*"]}
          // Only the outer page loads at the top; the app opens links through
          // the bridge. Android reports every navigation as top-frame, frames
          // the app nests included, so it has no gate to apply: there the
          // outer page never navigates, and the app frame's sandbox already
          // forbids top navigation and popups.
          onShouldStartLoadWithRequest={(request) =>
            Platform.OS === "android" ||
            request.isTopFrame === false ||
            request.url === "about:blank"
          }
          setSupportMultipleWindows={false}
          onLoadEnd={() => setLoaded(true)}
          // The outer page is inline HTML, so these report a broken view, not
          // an app page; the row shows the failure instead of a blank box.
          onError={() => setCrashed(true)}
          onHttpError={() => setCrashed(true)}
          onMessage={(event: WebViewMessageEvent) => {
            let envelope: unknown;
            try {
              envelope = JSON.parse(event.nativeEvent.data);
            } catch {
              return; // Not JSON: not a bridge message.
            }
            if (!Predicate.isObject(envelope) || envelope.secret !== secret) return;
            const message = envelope.message;
            if (Predicate.isObject(message) && message.t3 === "navigated") {
              hostRef.current?.dispose();
              setNavigatedAway(true);
              return;
            }
            hostRef.current?.receive(message);
          }}
        />
      ) : asset._tag === "Failure" || crashed ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">Unable to load the {app.server} app</Text>
        </View>
      ) : null}
      {uri !== null && !loaded && !crashed && !navigatedAway ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : null}
    </View>
  );
}
