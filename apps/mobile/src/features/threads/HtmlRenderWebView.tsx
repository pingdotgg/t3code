import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View, type ColorValue } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import type { deriveThreadWorkLogSizing } from "../../lib/layout";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { HTML_RENDER_ROW_BOTTOM_MARGIN } from "./thread-feed-item-size";
import { WorkLogIconSlot, WorkLogLabel, WorkLogPressable } from "./work-log-layout";

const FULL_SCREEN_GUTTER = 16;
const CONTROL_CLASS_NAME =
  "h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-surface/80";

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return useMemo(
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
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme) {
  view?.injectJavaScript(
    `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`,
  );
}

const OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

// Reports whether the page overflows its frame, so a feed row only takes scroll
// gestures from a page that can use them.
const OVERFLOW_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,b=document.body;var o=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1||Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1;if(o===last)return;last=o;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},overflow:o}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);})();true;`;

function readOverflowMessage(data: string) {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === OVERFLOW_MESSAGE_TYPE &&
      "overflow" in message &&
      typeof message.overflow === "boolean"
      ? message.overflow
      : null;
  } catch {
    return null;
  }
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

/**
 * An agent's HTML page, themed before first paint and kept in step with the app theme.
 * The page may move within its own document; links leave for the browser.
 */
export function HtmlRenderWebView(props: {
  readonly uri: string;
  readonly title: string;
  /** Inside the feed, the page takes scroll gestures only when it overflows its frame. */
  readonly nested: boolean;
  readonly onLoadError?: () => void;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const webView = useRef<WebView<object>>(null);
  const crashes = useRef(0);
  // The theme the loaded document shows; null until it loads.
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const source = useMemo(
    () => ({ uri: props.uri + htmlRenderThemeFragment(initialTheme) }),
    [props.uri, initialTheme],
  );
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme);
  }, [theme]);
  const restart = () => {
    // A page that keeps crashing its web process is not reloaded forever.
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setOverflows(false);
    setGeneration((value) => value + 1);
  };
  const scrollable = !props.nested || overflows;
  // Pages have no horizontal padding of their own, so full screen adds the
  // feed's gutter in the page's background color.
  return (
    <View
      style={
        props.nested
          ? { flex: 1 }
          : {
              flex: 1,
              paddingHorizontal: FULL_SCREEN_GUTTER,
              backgroundColor: theme.variables["--background"],
            }
      }
    >
      <WebView<object>
        key={generation}
        ref={webView}
        source={source}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        allowsInlineMediaPlayback
        automaticallyAdjustContentInsets={!props.nested}
        bounces={!props.nested}
        showsVerticalScrollIndicator={!props.nested}
        showsHorizontalScrollIndicator={!props.nested}
        scrollEnabled={scrollable}
        nestedScrollEnabled={props.nested && overflows}
        overScrollMode={props.nested ? "never" : "always"}
        // Only the page itself loads here; other top-frame navigations are
        // dropped. A link the reader taps opens as a new window, which the
        // platform allows only from a tap, and goes to the browser.
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false ||
          withoutFragment(request.url) === withoutFragment(props.uri)
        }
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (/^https?:/i.test(url)) void tryOpenExternalUrl(url, "html-render");
        }}
        onLoadEnd={() => {
          setLoaded(true);
          shownTheme.current = theme;
          if (theme !== initialTheme) postTheme(webView.current, theme);
        }}
        onError={props.onLoadError}
        onHttpError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
        {...(props.nested
          ? {
              injectedJavaScript: OVERFLOW_SCRIPT,
              onMessage: (event: WebViewMessageEvent) => {
                const overflow = readOverflowMessage(event.nativeEvent.data);
                if (overflow !== null) setOverflows(overflow);
              },
            }
          : {})}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

/**
 * A completed `html_render` call in the thread feed. Shown, it is the page
 * itself at a fixed height, with minimize and open controls over its corner.
 * Minimized, the page is unmounted and a title row stands in for it. The feed
 * owns `collapsed` and sizes the row from it; the published page is the same
 * either way.
 */
export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  /** The feed's content width; the frame's height follows the page's measured height there. */
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
}) {
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const fileName = htmlRenderFileName(title);
  const toggleCollapsed = () => {
    void Haptics.selectionAsync();
    props.onToggleCollapsed();
  };
  const open = () =>
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      attachmentId,
      name: fileName,
      mimeType: "text/html",
      sizeBytes: "0",
      htmlRender: "1",
    });
  const openSymbol = (
    <SymbolView
      name="arrow.up.left.and.arrow.down.right"
      size={12}
      tintColor={props.iconColor}
      type="monochrome"
    />
  );

  // The two roots are keyed apart so the title row and the page frame never
  // share a native view across a toggle.
  if (props.collapsed) {
    return (
      <View
        key="collapsed"
        className="flex-row items-center gap-1.5"
        style={{ marginBottom: HTML_RENDER_ROW_BOTTOM_MARGIN }}
      >
        <View className="min-w-0 flex-1">
          <WorkLogPressable
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            accessibilityLabel={title}
            accessibilityHint="Double tap to show the page."
            onPress={toggleCollapsed}
            rowSizing={props.rowSizing}
          >
            <WorkLogIconSlot>
              <SymbolView
                name="chevron.right"
                size={11}
                tintColor={props.iconColor}
                type="monochrome"
              />
            </WorkLogIconSlot>
            <WorkLogLabel key={props.rowSizing.textSizeKey}>{title}</WorkLogLabel>
          </WorkLogPressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          // The title row's own slop ends where this one would begin.
          hitSlop={{ top: 8, bottom: 8, right: 8 }}
          className="h-7 w-7 items-center justify-center rounded-md active:bg-subtle"
          onPress={open}
        >
          {openSymbol}
        </Pressable>
      </View>
    );
  }

  return (
    <View key="expanded" style={{ marginBottom: HTML_RENDER_ROW_BOTTOM_MARGIN }}>
      <View style={{ height: htmlRenderFrameHeight(props.render, props.frameWidth) }}>
        <ThreadHtmlRenderPage
          environmentId={props.environmentId}
          render={props.render}
          fileName={fileName}
        />
        {/* Each control keeps 8pt of slop on its outer sides; the gap holds the inner ones apart. */}
        <View className="absolute right-1.5 top-1.5 flex-row gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: true }}
            accessibilityLabel={`Minimize ${title}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 5 }}
            className={CONTROL_CLASS_NAME}
            onPress={toggleCollapsed}
          >
            <SymbolView name="chevron.up" size={12} tintColor={props.iconColor} type="monochrome" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            hitSlop={{ top: 8, bottom: 8, left: 5, right: 8 }}
            className={CONTROL_CLASS_NAME}
            onPress={open}
          >
            {openSymbol}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * The mounted page: its signed URL, its WebView, and the loading and failure
 * states that fill the same frame. It is mounted only while the render is
 * shown, so showing it again starts from the current URL with a fresh retry.
 */
function ThreadHtmlRenderPage(props: {
  readonly environmentId: EnvironmentId;
  readonly render: HtmlRenderReference;
  readonly fileName: string;
}) {
  const { attachmentId, title } = props.render;
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName: props.fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, props.fileName],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
  // A failed load retries once with a fresh URL, or remounts on the same one,
  // since the failure may have been the connection rather than the URL.
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setUri(next);
      else setAttempt((value) => value + 1);
    });
  };

  if (uri !== null && !failed) {
    return (
      <HtmlRenderWebView
        key={`${uri}:${attempt}`}
        uri={uri}
        title={title}
        nested
        onLoadError={handleLoadError}
      />
    );
  }
  if (failed || asset._tag === "Failure") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Reload ${title}`}
        className="flex-1 items-center justify-center"
        onPress={() => {
          retried.current = false;
          setFailed(false);
          if (uri === null) void refresh().then((next) => next !== null && setUri(next));
        }}
      >
        <Text className="text-sm text-foreground-muted">Page unavailable</Text>
      </Pressable>
    );
  }
  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator />
    </View>
  );
}
