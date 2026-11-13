import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Platform,
  Pressable,
  View,
  type ColorValue,
  type GestureResponderEvent,
  type ViewInstance,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  createBallotToken,
  createBallotTapGate,
  ballotScript,
  readBallotMessage,
  requestBallotPicks,
} from "./ballot";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const ROW_BOTTOM_MARGIN = 8;
const FULL_SCREEN_GUTTER = 16;

export function htmlRenderRowHeight(frameHeight: number) {
  return frameHeight + ROW_BOTTOM_MARGIN;
}

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return mobileHtmlRenderTheme({
    themeId,
    appearance: themeAppearance,
    variables: themeVariables,
    systemColors: systemColorsActive,
    platform: Platform.OS,
  });
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme) {
  view?.injectJavaScript(
    `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`,
  );
}

const OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

const FIELD_FOCUS_MESSAGE_TYPE = "t3-html-render-field-focus";

// Also reports the document's height, measured as the desktop bootstrap does, so a nested page's
// frame can fit it: a page that scrolls inside the thread hides its end and fights the thread's
// scrolling. A focused text field reports where it is, so the thread can lift it above the
// keyboard: the page can't, since the keyboard doesn't resize it.
const OVERFLOW_SCRIPT = `(function(){var last;function post(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}function report(){var d=document.documentElement,b=document.body;var x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,y=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1,h=Math.ceil(d.scrollHeight>d.clientHeight?d.scrollHeight:d.getBoundingClientRect().height),o=x+","+y+","+h;if(o===last)return;last=o;post({type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},x:x,y:y,h:h});}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);window.addEventListener("load",report);document.addEventListener("focusin",function(e){var t=e.target;if(!t||!(t.isContentEditable||t.tagName==="TEXTAREA"||t.tagName==="INPUT"&&/^(text|search|email|url|tel|number|password)$/.test(t.type)))return;var f=t.getBoundingClientRect();post({type:${JSON.stringify(FIELD_FOCUS_MESSAGE_TYPE)},top:f.top,bottom:f.bottom});},true);})();true;`;

type Overflow = { readonly x: boolean; readonly y: boolean };

const NO_OVERFLOW: Overflow = { x: false, y: false };

type OverflowReport = Overflow & { readonly height: number | undefined };

function readOverflowMessage(data: string): OverflowReport | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === OVERFLOW_MESSAGE_TYPE &&
      "x" in message &&
      typeof message.x === "boolean" &&
      "y" in message &&
      typeof message.y === "boolean"
      ? {
          x: message.x,
          y: message.y,
          height:
            "h" in message &&
            typeof message.h === "number" &&
            Number.isFinite(message.h) &&
            message.h > 0
              ? message.h
              : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

function readFieldFocusMessage(
  data: string,
): { readonly top: number; readonly bottom: number } | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === FIELD_FOCUS_MESSAGE_TYPE &&
      "top" in message &&
      typeof message.top === "number" &&
      Number.isFinite(message.top) &&
      "bottom" in message &&
      typeof message.bottom === "number" &&
      Number.isFinite(message.bottom)
      ? { top: message.top, bottom: message.bottom }
      : null;
  } catch {
    return null;
  }
}

/** Where a focused field in a nested page is, in window coordinates, measured when called. */
export type HtmlRenderFieldMeasure = () => Promise<{
  readonly top: number;
  readonly bottom: number;
}>;

const withoutFragment = (url: string) => url.split("#", 1)[0];

// Live page heights by attachment and frame width. The feed sizes rows before they mount, and a
// row that mounts again (scrolled back into view) must not shrink to the server's guess and regrow.
// The feed gives these rows fixed sizes, which it never re-measures, so it re-renders on a change.
const liveHeights = new Map<string, number>();
const liveHeightListeners = new Set<() => void>();
let liveHeightsVersion = 0;
const liveHeightKey = (attachmentId: string, width: number) =>
  `${attachmentId}:${Math.round(width)}`;

export function htmlRenderLiveHeight(attachmentId: string, width: number): number | undefined {
  return liveHeights.get(liveHeightKey(attachmentId, width));
}

export function subscribeHtmlRenderLiveHeights(listener: () => void): () => void {
  liveHeightListeners.add(listener);
  return () => {
    liveHeightListeners.delete(listener);
  };
}

export const htmlRenderLiveHeightsVersion = () => liveHeightsVersion;

function setHtmlRenderLiveHeight(attachmentId: string, width: number, height: number) {
  const key = liveHeightKey(attachmentId, width);
  if (liveHeights.get(key) === height) return;
  liveHeights.set(key, height);
  liveHeightsVersion += 1;
  for (const listener of liveHeightListeners) listener();
}

export function HtmlRenderWebView(props: {
  readonly uri: string;
  readonly title: string;
  readonly nested: boolean;
  readonly onLoadError?: () => void;
  readonly onContentHeight?: (height: number) => void;
  readonly onFieldFocus?: (measure: HtmlRenderFieldMeasure) => void;
  /** Custom build: picks a ballot's `t3Compose(text)` hands to the message box after a tap. */
  readonly onBallotPicks?: (text: string) => void;
}) {
  const theme = useHtmlRenderTheme();
  // Only a ballot view needs a token; whether it is one is fixed by its call site.
  const [ballotToken] = useState(() =>
    props.onBallotPicks === undefined ? null : createBallotToken(),
  );
  const [tapGate] = useState(createBallotTapGate);
  const isBallot = ballotToken !== null && props.onBallotPicks !== undefined;
  const touchPoint = (event: GestureResponderEvent) => ({
    x: event.nativeEvent.pageX,
    y: event.nativeEvent.pageY,
    at: Date.now(),
  });
  const handOverPicks = (texts: readonly string[]) => {
    for (const text of texts) props.onBallotPicks?.(text);
  };
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const webView = useRef<WebView<object>>(null);
  const frame = useRef<ViewInstance>(null);
  const crashes = useRef(0);
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const source = { uri: props.uri + htmlRenderThemeFragment(initialTheme) };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes into the already loaded WebView
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme);
  }, [theme]);
  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setOverflow(NO_OVERFLOW);
    setGeneration((value) => value + 1);
  };
  const scrollable = !props.nested || overflow.x || overflow.y;
  return (
    <View
      ref={frame}
      // Raw touches reach this wrapper even when the web view handles them. A page may only fill
      // the message box just after a tap (a touch that barely moved), not on load, on its own
      // timer or during a scroll.
      onTouchStart={isBallot ? (event) => tapGate.touchStart(touchPoint(event)) : undefined}
      onTouchEnd={
        isBallot ? (event) => handOverPicks(tapGate.touchEnd(touchPoint(event))) : undefined
      }
      onTouchCancel={isBallot ? () => tapGate.touchCancel() : undefined}
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
        contentInsetAdjustmentBehavior={props.nested ? "never" : "automatic"}
        bounces={!props.nested}
        showsVerticalScrollIndicator={!props.nested}
        showsHorizontalScrollIndicator={!props.nested}
        scrollEnabled={scrollable}
        // Android's patched WebView always keeps horizontal drags. Only pages
        // with vertical overflow hold vertical drags until they reach an edge.
        nestedScrollEnabled={props.nested && overflow.y}
        overScrollMode={props.nested ? "never" : "always"}
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
        {...(props.nested ? { injectedJavaScript: OVERFLOW_SCRIPT } : {})}
        {...(isBallot ? { injectedJavaScriptBeforeContentLoaded: ballotScript(ballotToken) } : {})}
        {...(props.nested || isBallot
          ? {
              onMessage: (event: WebViewMessageEvent) => {
                const next = props.nested ? readOverflowMessage(event.nativeEvent.data) : null;
                if (next !== null) {
                  setOverflow((current) =>
                    current.x === next.x && current.y === next.y
                      ? current
                      : { x: next.x, y: next.y },
                  );
                  if (next.height !== undefined) props.onContentHeight?.(next.height);
                  return;
                }
                const field = props.nested ? readFieldFocusMessage(event.nativeEvent.data) : null;
                if (field !== null) {
                  props.onFieldFocus?.(
                    () =>
                      new Promise((resolve) => {
                        frame.current?.measureInWindow((_x, y) =>
                          resolve({ top: y + field.top, bottom: y + field.bottom }),
                        );
                      }),
                  );
                  return;
                }
                const request = isBallot
                  ? readBallotMessage(event.nativeEvent.data, ballotToken)
                  : undefined;
                if (request !== undefined) handOverPicks(tapGate.request(request.text, Date.now()));
              },
            }
          : {})}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
  /** Called with the old frame height just before a live page height resizes the frame. */
  readonly onResize?: (previousHeight: number) => void;
  readonly onFieldFocus?: (measure: HtmlRenderFieldMeasure) => void;
}) {
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const liveHeight = useSyncExternalStore(subscribeHtmlRenderLiveHeights, () =>
    htmlRenderLiveHeight(attachmentId, props.frameWidth),
  );
  const height = htmlRenderFrameHeight(props.render, props.frameWidth, liveHeight);
  const handleContentHeight = (next: number) => {
    if (htmlRenderFrameHeight(props.render, props.frameWidth, next) !== height) {
      props.onResize?.(htmlRenderRowHeight(height));
    }
    setHtmlRenderLiveHeight(attachmentId, props.frameWidth, next);
  };
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
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

  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height }}>
        {uri !== null && !failed ? (
          <HtmlRenderWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            nested
            onLoadError={handleLoadError}
            onContentHeight={handleContentHeight}
            {...(props.onFieldFocus ? { onFieldFocus: props.onFieldFocus } : {})}
            onBallotPicks={(text) =>
              requestBallotPicks({
                threadKey: scopedThreadKey(props.environmentId, props.threadId),
                text,
              })
            }
          />
        ) : failed || asset._tag === "Failure" ? (
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
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            hitSlop={8}
            className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(props.environmentId),
                threadId: String(props.threadId),
                attachmentId,
                name: fileName,
                mimeType: "text/html",
                sizeBytes: "0",
                htmlRender: "1",
              })
            }
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
