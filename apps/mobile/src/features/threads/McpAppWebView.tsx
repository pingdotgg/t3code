import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
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
import { AsyncResult } from "effect/reactivity";
import Constants from "expo-constants";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/ui/AppText";
import { shareGeneratedAttachment } from "../../lib/attachmentDownload";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { useAssetUrlState } from "../../state/assets";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { MCP_APP_INLINE_MAX_HEIGHT, mcpAppInlineHeight } from "./mcpAppSizing";

const ROW_BOTTOM_MARGIN = 8;

// Android exposes `ReactNativeWebView` to every frame, so a frame nested in the
// app could post to React Native directly. The outer page therefore wraps what
// it relays with a secret only it holds, and React Native drops anything else.
// The relay also attests activation; the sandboxed app cannot set that flag.
function outerDocument(src: string, allow: string, secret: string) {
  const attribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="allow-scripts allow-forms" allow="${attribute(allow)}"></iframe>
<script>(function(){var frame=document.getElementById("app"),secret=${JSON.stringify(secret)},loads=0,live=true;
var send=function(m){var u=navigator.userActivation;window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,active:!!(u&&u.isActive)&&document.activeElement===frame,message:m}));};
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
    Dialog.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ],
      // Android dismisses earlier alerts when showing another; decline dismissed requests to release their slots.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

// The feed omits tool input and output; the app needs both.
function storedToolCall(
  item: { readonly type: string; readonly input?: unknown; readonly output?: unknown } | null,
) {
  if (item?.type !== "dynamic_tool") return undefined;
  const output = item.output as { readonly result?: unknown } | undefined;
  return {
    arguments: item.input,
    result: output?.result as McpAppCallToolResult | undefined,
  };
}

/** WebViews reload when moved; tear down inline before opening fullscreen and recreate it on return. */
export function ThreadMcpApp(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
  readonly app: McpAppReference;
  readonly width: number;
  readonly displayMode?: "inline" | "fullscreen";
  readonly onExitFullscreen?: () => void;
  readonly height?: number;
}) {
  const [height, setHeight] = useState(MCP_APP_INLINE_MAX_HEIGHT);
  const [documentKey, setDocumentKeyState] = useState(0);
  // The view keeps its first URL: a re-minted one would reload the app.
  const [uri, setUri] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);
  // Equal app content must retain its reference to preserve the live document host.
  // A different app needs a new document even when its asset URL is unchanged,
  // so the WebView key moves on with the document key, not only the URL.
  const [app, setApp] = useState(props.app);
  if (!mcpAppReferencesEqual(app, props.app)) {
    setApp(props.app);
    setHeight(MCP_APP_INLINE_MAX_HEIGHT);
    setUri(null);
    setLoaded(false);
    setNavigatedAway(false);
    setDocumentKeyState((value) => value + 1);
  }
  const fullscreen = props.displayMode === "fullscreen";
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [closed, setClosed] = useState(false);
  const [presentedFullscreen, setPresentedFullscreen] = useState(false);

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
      renderIntent: "mcp-app" as const,
    }),
    [app],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [generation, setGeneration] = useState(0);
  const [crashed, setCrashed] = useState(false);
  const restart = () => {
    if (generation > 0) {
      setCrashed(true);
      return;
    }
    setLoaded(false);
    setHeight(MCP_APP_INLINE_MAX_HEIGHT);
    // Use the asset query's refreshed token when creating a replacement view.
    if (asset._tag === "Success") setUri(asset.url);
    setGeneration(1);
  };
  const [secret] = useState(uuidv4);
  const reopenDocument = () => {
    setLoaded(false);
    setHeight(MCP_APP_INLINE_MAX_HEIGHT);
    setNavigatedAway(false);
    if (asset._tag === "Success") setUri(asset.url);
    setDocumentKeyState((value) => value + 1);
  };
  const returnedFromFullscreen = useEffectEvent(() => {
    reopenDocument();
    setPresentedFullscreen(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Navigation focus is outside React; listen only while the app is presented full screen, and stop on unmount.
  useEffect(() => {
    if (!presentedFullscreen) return;
    return navigation.addListener("focus", () => returnedFromFullscreen());
  }, [navigation, presentedFullscreen]);

  const detailAtom = orchestrationEnvironment.turnItem({
    environmentId: props.environmentId,
    input: { threadId: props.threadId, itemId: props.itemId, revision: props.revision },
  });
  const toolInfo = useEnvironmentQuery(
    mcpAppEnvironment.toolInfoQuery({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
    }),
  );
  const toolDefinition = toolInfo.data?.tool;

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfoCommand = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });
  // Read current context per message without rebuilding the host and losing its session.
  const conversation = useThreadShell(
    scopeThreadRef(props.environmentId, props.conversationThreadId),
  );
  const awaitingUser =
    conversation?.hasPendingApprovals === true || conversation?.hasPendingUserInput === true;
  const live = {
    awaitingUser,
    theme,
    props,
    asset,
    callTool,
    toolInfo: toolInfoCommand,
    readResource,
    updateModelContext,
    insets,
    toolDefinition,
    navigation,
  };
  const latest = useRef(live);
  // The attached WebView owns its host; state lets the tool-call effect pair
  // a host only with an atom from a render after that host existed.
  const [host, setHost] = useState<McpAppHost | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resends host context to the MCP app host after commits that change theme, insets, tool or size
  useEffect(() => {
    const previous = latest.current;
    latest.current = live;
    // Building the context is not free, so resend only when one of its inputs changed.
    if (
      previous.theme !== live.theme ||
      previous.insets !== live.insets ||
      previous.toolDefinition !== live.toolDefinition ||
      previous.props.width !== live.props.width ||
      previous.props.height !== live.props.height ||
      previous.props.displayMode !== live.props.displayMode
    ) {
      host?.updateHostContext();
    }
  });
  // The host sends the call once the app initializes, so a stored item that
  // lands late still reaches it. A completed call can arrive under a new
  // revision, which is a new atom, so the host follows the current one.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the MCP host to the current tool call
  useEffect(() => {
    if (host === null) return;
    return appAtomRegistry.subscribe(
      detailAtom,
      (result) => {
        const call = AsyncResult.isSuccess(result) ? storedToolCall(result.value.item) : undefined;
        if (call !== undefined) host.setToolCall(call);
      },
      { immediate: true },
    );
  }, [host, detailAtom]);
  const userActive = useRef(false);

  // Each WebView document gets its own host: the view is keyed by document,
  // restart generation and URL, and a changed app re-attaches this callback.
  // Any other identity change would tear the host down, so per-render values
  // are read through `latest`, never captured.
  const attachWebView = useCallback(
    (view: WebView<object> | null) => {
      if (view === null) return;
      const reloadInline = () => {
        setLoaded(false);
        setHeight(MCP_APP_INLINE_MAX_HEIGHT);
        setNavigatedAway(false);
        const current = latest.current.asset;
        if (current._tag === "Success") setUri(current.url);
        setDocumentKeyState((value) => value + 1);
      };
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
          containerDimensions: isFullscreen
            ? {
                width: current.props.width,
                height: current.props.height ?? MCP_APP_INLINE_MAX_HEIGHT,
              }
            : { width: current.props.width, maxHeight: MCP_APP_INLINE_MAX_HEIGHT },
          platform: "mobile",
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: `t3-code/${Constants.expoConfig?.version ?? "0.0.0"}`,
          deviceCapabilities: { touch: true, hover: false },
          safeAreaInsets: isFullscreen
            ? { top: 0, right: current.insets.right, bottom: 0, left: current.insets.left }
            : { top: 0, right: 0, bottom: 0, left: 0 },
          ...(current.toolDefinition === undefined
            ? {}
            : { toolInfo: { tool: current.toolDefinition } }),
        };
      };
      const documentHost: McpAppHost = makeMcpAppHost({
        app,
        hostVersion: Constants.expoConfig?.version ?? "0.0.0",
        post: (message) =>
          view.injectJavaScript(
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
          // WebViews cannot prove user activation; confirm links to prevent timer-driven navigation out of T3.
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
          // receive dispatches synchronously; read activation before awaiting teardown.
          if (
            mode === "fullscreen" &&
            (!userActive.current ||
              latest.current.awaitingUser ||
              !latest.current.navigation.isFocused())
          ) {
            return current.displayMode ?? "inline";
          }
          if (mode === "fullscreen" && current.displayMode !== "fullscreen") {
            await documentHost.teardown();
            // Approval arrival or navigation during the wait requires reloading inline.
            const navigation = latest.current.navigation;
            if (latest.current.awaitingUser || !navigation.isFocused()) {
              reloadInline();
              return "inline";
            }
            setPresentedFullscreen(true);
            navigation.navigate("ThreadMcpApp", {
              environmentId: String(current.environmentId),
              threadId: String(current.threadId),
              conversationThreadId: String(current.conversationThreadId),
              itemId: String(current.itemId),
              revision: current.revision,
            });
            return "fullscreen";
          }
          if (mode === "inline" && current.displayMode === "fullscreen") {
            await documentHost.teardown();
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
            void documentHost.teardown().then(() => current.onExitFullscreen?.());
          } else {
            void documentHost.teardown().then(() => setClosed(true));
          }
        },
        onSizeChanged: (size) => {
          if (latest.current.props.displayMode === "fullscreen") return;
          const nextHeight = mcpAppInlineHeight(size.height);
          if (nextHeight !== undefined) setHeight(nextHeight);
        },
      });
      setHost(documentHost);
      return () => {
        // An unmount cannot wait: the request goes out before the view does.
        void documentHost.teardown();
        setHost((current) => (current === documentHost ? null : current));
      };
    },
    [app],
  );

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
        style={{ height, marginBottom: ROW_BOTTOM_MARGIN }}
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
        style={{ height, marginBottom: ROW_BOTTOM_MARGIN }}
        className="items-center justify-center gap-2 rounded-lg border border-border"
      >
        <Text className="text-sm text-foreground-muted">The {app.server} app was closed</Text>
        <View className="items-center">
          <Button
            label="Show app"
            tone="secondary"
            onPress={() => {
              reopenDocument();
              setClosed(false);
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={fullscreen ? { flex: 1 } : { height, marginBottom: ROW_BOTTOM_MARGIN }}>
      {navigatedAway ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">
            The {app.server} app left its page and was stopped
          </Text>
        </View>
      ) : uri !== null && !crashed ? (
        <WebView<object>
          key={`${documentKey}:${generation}:${uri}`}
          ref={attachWebView}
          onContentProcessDidTerminate={restart}
          onRenderProcessGone={restart}
          source={source!}
          accessibilityLabel={`${app.server} app`}
          style={{ flex: 1, backgroundColor: "transparent" }}
          nestedScrollEnabled
          originWhitelist={["*"]}
          // Android misreports nested frames as top-level; rely on iframe sandboxing there and gate navigation elsewhere.
          onShouldStartLoadWithRequest={(request) =>
            Platform.OS === "android" ||
            request.isTopFrame === false ||
            request.url === "about:blank"
          }
          setSupportMultipleWindows={false}
          onLoadEnd={() => setLoaded(true)}
          onError={() => setCrashed(true)}
          onHttpError={() => setCrashed(true)}
          onMessage={(event: WebViewMessageEvent) => {
            let envelope: unknown;
            try {
              envelope = JSON.parse(event.nativeEvent.data);
            } catch {
              return;
            }
            if (!Predicate.isObject(envelope) || envelope.secret !== secret) return;
            const message = envelope.message;
            if (Predicate.isObject(message) && message.t3 === "navigated") {
              host?.dispose();
              setNavigatedAway(true);
              return;
            }
            userActive.current = envelope.active === true;
            host?.receive(message);
            userActive.current = false;
          }}
        />
      ) : asset._tag === "Failure" || crashed ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">Unable to load the {app.server} app</Text>
        </View>
      ) : null}
      {uri !== null && !loaded && !crashed && !navigatedAway ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      ) : null}
    </View>
  );
}
