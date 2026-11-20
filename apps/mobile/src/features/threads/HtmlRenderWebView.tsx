import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@t3tools/contracts";
import type { AssistantTextSelector } from "@t3tools/shared/assistantCitations";
import {
  htmlRenderClearSelectionMessage,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderSelection,
  type HtmlRenderReference,
  type HtmlRenderSelection,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { T, useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View, type ColorValue } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { webViewDecelerationRate } from "../../lib/webViewDecelerationRate";

const ROW_BOTTOM_MARGIN = 8;
const ACTION_ROW_HEIGHT = 32;
const FULL_SCREEN_GUTTER = 16;
const CITE_HEIGHT = 30;
const CITE_GAP = 6;

// One page offers Cite at a time; a selection in another page takes it over.
let dismissPageCite: (() => void) | null = null;

export function htmlRenderRowHeight(frameHeight: number) {
  return ACTION_ROW_HEIGHT + frameHeight + ROW_BOTTOM_MARGIN;
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

const OVERFLOW_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,b=document.body;var x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,y=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1,o=x+","+y;if(o===last)return;last=o;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},x:x,y:y}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);})();true;`;

type Overflow = { readonly x: boolean; readonly y: boolean };

const NO_OVERFLOW: Overflow = { x: false, y: false };

function parseMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function readOverflowMessage(message: unknown): Overflow | null {
  return typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === OVERFLOW_MESSAGE_TYPE &&
    "x" in message &&
    typeof message.x === "boolean" &&
    "y" in message &&
    typeof message.y === "boolean"
    ? { x: message.x, y: message.y }
    : null;
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

export function HtmlRenderWebView(props: {
  readonly uri: string;
  readonly title: string;
  readonly nested: boolean;
  readonly onLoadError?: () => void;
  /** The reader's text selection in a nested page, or null once it is gone. */
  readonly onSelection?: (selection: HtmlRenderSelection | null, clear: () => void) => void;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const webView = useRef<WebView<object>>(null);
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
        decelerationRate={webViewDecelerationRate}
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
        {...(props.nested
          ? {
              injectedJavaScript: OVERFLOW_SCRIPT,
              onMessage: (event: WebViewMessageEvent) => {
                const message = parseMessage(event.nativeEvent.data);
                const next = readOverflowMessage(message);
                if (next !== null) {
                  setOverflow(next);
                  return;
                }
                const selection = readHtmlRenderSelection(message);
                if (selection !== undefined) {
                  props.onSelection?.(selection, () =>
                    webView.current?.injectJavaScript(
                      `window.postMessage(${JSON.stringify(htmlRenderClearSelectionMessage())}, "*"); true;`,
                    ),
                  );
                }
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
  /** Offers Cite for text the reader selects in the page. */
  readonly onCite?: ((selector: AssistantTextSelector) => void) | undefined;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const height = htmlRenderFrameHeight(props.render, props.frameWidth);
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
  const [selection, setSelection] = useState<{
    readonly value: HtmlRenderSelection;
    readonly clear: () => void;
  } | null>(null);
  const [citeWidth, setCiteWidth] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the one Cite slot over from another page's selection
  useEffect(() => {
    if (selection === null) return;
    const dismiss = () => setSelection(null);
    dismissPageCite?.();
    dismissPageCite = dismiss;
    return () => {
      if (dismissPageCite === dismiss) dismissPageCite = null;
    };
  }, [selection]);
  const citeTop = (rect: HtmlRenderSelection["rect"]) => {
    const below = rect.bottom + CITE_GAP;
    return Math.max(0, below + CITE_HEIGHT <= height ? below : rect.top - CITE_GAP - CITE_HEIGHT);
  };
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
      <View style={{ height: ACTION_ROW_HEIGHT }} className="flex-row items-start justify-end">
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Open {title}", { title })}
            hitSlop={8}
            className="h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
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
      <View style={{ height }}>
        {uri !== null && !failed ? (
          <>
            <HtmlRenderWebView
              key={`${uri}:${attempt}`}
              uri={uri}
              title={title}
              nested
              onLoadError={handleLoadError}
              onSelection={
                props.onCite ? (value, clear) => setSelection(value && { value, clear }) : undefined
              }
            />
            {selection !== null && props.onCite ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={6}
                className="absolute justify-center rounded-full border border-border/60 bg-card px-3"
                style={{
                  height: CITE_HEIGHT,
                  left: Math.max(
                    0,
                    Math.min(selection.value.rect.right - citeWidth, props.frameWidth - citeWidth),
                  ),
                  top: citeTop(selection.value.rect),
                }}
                onLayout={(event) => setCiteWidth(Math.ceil(event.nativeEvent.layout.width))}
                onPress={() => {
                  if (selection.value.selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
                    Dialog.alert(
                      gt("Quote is too long"),
                      gt("Select up to {max} characters to cite.", {
                        max: ASSISTANT_CITATION_MAX_TEXT_LENGTH.toLocaleString(),
                      }),
                    );
                    return;
                  }
                  props.onCite?.(selection.value.selector);
                  selection.clear();
                  setSelection(null);
                }}
              >
                <Text className="text-[13px] font-medium text-foreground">
                  {gt("Cite", { $context: "verb, quote selected text" })}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : failed || asset._tag === "Failure" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Reload {title}", { title })}
            className="flex-1 items-center justify-center"
            onPress={() => {
              retried.current = false;
              setFailed(false);
              if (uri === null) void refresh().then((next) => next !== null && setUri(next));
            }}
          >
            <Text className="text-sm text-foreground-muted">
              <T>Page unavailable</T>
            </Text>
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
      </View>
    </View>
  );
}
