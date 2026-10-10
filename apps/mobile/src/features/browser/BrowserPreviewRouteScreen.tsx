import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import type { PreviewStreamInput } from "@t3tools/client-runtime/preview/server-browser-stream";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Platform, TextInput, View } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ControlPill";
import { ScreenHeader } from "../../components/ScreenHeader";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useThreadServerBrowserTabs } from "../../state/preview";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserClipboardMenu } from "./BrowserClipboardMenu";
import { BrowserPasswordFill, type BrowserLogin } from "./BrowserPasswordFill";
import { BrowserTabMenu } from "./BrowserTabMenu";
import { browserTabOrigin, browserTabTitle, browserTabUrl, latestBrowserTab } from "./browserTabs";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "./PreviewStreamWebView";

const BrowserPreviewStack = createNativeStackNavigator<{ BrowserPreview: undefined }>();

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };
// Cmd+C runs as the page's copy command, and the page sends its selection back.
const COPY_KEY = { key: "c", code: "KeyC", keyCode: 67, modifiers: 4 } as const;

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
}>;

/** The nested native stack supplies the navigation bar inside the modal. */
export function BrowserPreviewRouteScreen({ route }: BrowserPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <BrowserPreviewStack.Navigator
        screenOptions={{
          headerShown: Platform.OS === "ios",
          headerBackVisible: false,
          headerShadowVisible: false,
          headerTransparent: false,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        }}
      >
        <BrowserPreviewStack.Screen name="BrowserPreview">
          {() => (
            <BrowserPreviewScreen
              environmentId={EnvironmentId.make(route.params.environmentId)}
              threadId={ThreadId.make(route.params.threadId)}
              initialTabId={route.params.tabId ?? null}
              onClose={onClose}
            />
          )}
        </BrowserPreviewStack.Screen>
      </BrowserPreviewStack.Navigator>
    </View>
  );
}

function BrowserPreviewScreen({
  environmentId,
  threadId,
  initialTabId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly initialTabId: string | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [selectedTabId, setSelectedTabId] = useState(initialTabId);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  // Address bar commands only reach a page that is streaming.
  const [streaming, setStreaming] = useState(false);
  const [canControl, setCanControl] = useState(false);
  // A page field has this device's keyboard.
  const [typing, setTyping] = useState(false);
  // The site a saved login goes to, fixed when the fill card opens; null while it is closed.
  const [fillOrigin, setFillOrigin] = useState<string | null>(null);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const streamRef = useRef<PreviewStreamRef>(null);
  const { tabs, loaded } = useThreadServerBrowserTabs({ environmentId, threadId, enabled: true });
  const tab = tabs.find((entry) => entry.tabId === selectedTabId) ?? latestBrowserTab(tabs);
  const tabId = tab?.tabId ?? null;
  // Pin the fallback so another tab's activity does not switch the view.
  if (tabId !== null && tabId !== selectedTabId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setFillOrigin(null);
    setSelectedTabId(tabId);
  }
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (focused && loaded && tabs.length === 0) onClose();
  }, [focused, loaded, tabs.length, onClose]);
  const onPictureInPicture = useCallback((state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Alert.alert("Picture in picture is unavailable", detail);
  }, []);
  const selectTab = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setFillOrigin(null);
    setSelectedTabId(next);
  };
  // System picture in picture keeps showing this stream after the app leaves the foreground.
  const live = (focused && foreground) || pictureInPicture.active;
  const send = (input: PreviewStreamInput) => streamRef.current?.command(input);
  const pasteFromClipboard = async () => {
    // Reading can wait on the paste prompt; if the tab changes meanwhile, nothing is pasted.
    const stream = streamRef.current;
    const text = await Clipboard.getStringAsync().catch(() => "");
    if (text && stream && streamRef.current === stream) stream.command({ type: "text", text });
  };
  const copySelection = () => {
    send({ type: "key", action: "down", ...COPY_KEY });
    send({ type: "key", action: "up", ...COPY_KEY });
  };
  const pageOrigin = tab ? browserTabOrigin(tab) : null;
  const fillLogin = (login: BrowserLogin) => {
    if (fillOrigin === null) return;
    setFillOrigin(null);
    send({ type: "fillLogin", origin: fillOrigin, ...login });
  };

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <ScreenHeader
        title={tab ? browserTabTitle(tab) : "Browser"}
        sidebar={false}
        onBack={onClose}
        options={{ headerBackVisible: false }}
        actions={
          // Android WebView cannot play video in picture in picture.
          Platform.OS === "ios" && pictureInPicture.supported
            ? [
                {
                  accessibilityLabel: pictureInPicture.active
                    ? "Exit picture in picture"
                    : "Picture in picture",
                  icon: {
                    ios: pictureInPicture.active ? "pip.exit" : "pip.enter",
                    android: "visibility",
                  },
                  selected: pictureInPicture.active,
                  onPress: () => streamRef.current?.togglePictureInPicture(),
                },
              ]
            : []
        }
        menus={
          tabs.length > 1
            ? [
                {
                  title: "Tabs",
                  icon: "square.on.square",
                  items: tabs.map((entry) => ({
                    id: entry.tabId,
                    title: browserTabTitle(entry),
                    subtitle: browserTabUrl(entry),
                    selected: entry.tabId === tabId,
                    onPress: () => selectTab(entry.tabId),
                  })),
                },
              ]
            : []
        }
      />
      {Platform.OS === "ios" ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            icon="xmark"
            accessibilityLabel="Close browser"
            onPress={onClose}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}
      {tab ? (
        <>
          <BrowserAddressBar
            key={tab.tabId}
            environmentId={environmentId}
            tab={tab}
            streaming={streaming}
            ready={streaming && canControl}
            onCommand={(input) => streamRef.current?.command(input)}
          />
          {live ? (
            <PreviewStreamWebView
              key={tab.tabId}
              environmentId={environmentId}
              threadId={threadId}
              tabId={tab.tabId}
              ref={streamRef}
              interactive
              background={themeVariables["--color-sheet-solid"]}
              onPictureInPicture={onPictureInPicture}
              onStreamingChange={setStreaming}
              onPageInput={setTyping}
              onControl={(control) => setCanControl(control?.controller === "you")}
            />
          ) : (
            <View className="flex-1" />
          )}
          {live && canControl && fillOrigin !== null ? (
            <BrowserPasswordFill
              origin={fillOrigin}
              onFill={fillLogin}
              onCancel={() => setFillOrigin(null)}
            />
          ) : null}
          {live && canControl && typing && keyboardVisible && fillOrigin === null ? (
            <KeyboardStickyView
              pointerEvents="box-none"
              style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
              offset={{ closed: 0, opened: 0 }}
            >
              <View pointerEvents="box-none" className="flex-row px-3 pb-3">
                <BrowserClipboardMenu
                  onPaste={() => void pasteFromClipboard()}
                  onCopy={copySelection}
                  onFillPassword={pageOrigin === null ? null : () => setFillOrigin(pageOrigin)}
                />
              </View>
            </KeyboardStickyView>
          ) : null}
        </>
      ) : (
        <View className="flex-1 items-center justify-center">
          {focused && foreground ? (
            <ActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function BrowserAddressBar({
  environmentId,
  tab,
  ready,
  streaming,
  onCommand,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: PreviewSessionSnapshot;
  /** The viewer controls the page, so navigation and reload apply. */
  readonly ready: boolean;
  /** The menu's changes need no control, only a live tab. */
  readonly streaming: boolean;
  readonly onCommand: PreviewStreamRef["command"];
}) {
  const url = browserTabUrl(tab);
  // Null while not editing, so agent navigation keeps the field current.
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const value = draft ?? url;
    setDraft(null);
    try {
      onCommand({ type: "navigate", url: normalizePreviewUrl(value) });
    } catch {
      Alert.alert("Could not open this address", "Enter an http or https URL.");
    }
  };
  return (
    <View className="flex-row items-center gap-1 px-2 pb-2">
      <ControlPill
        icon="chevron.left"
        accessibilityLabel="Back"
        disabled={!ready || !tab.canGoBack}
        onPress={() => onCommand({ type: "history", delta: -1 })}
      />
      <ControlPill
        icon="chevron.right"
        accessibilityLabel="Forward"
        disabled={!ready || !tab.canGoForward}
        onPress={() => onCommand({ type: "history", delta: 1 })}
      />
      <TextInput
        accessibilityLabel="Address"
        editable={ready}
        value={draft ?? url}
        onChangeText={setDraft}
        onBlur={() => setDraft(null)}
        onSubmitEditing={submit}
        placeholder="Enter a URL"
        placeholderTextColorClassName="accent-placeholder"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
      />
      <ControlPill
        icon="arrow.clockwise"
        accessibilityLabel="Reload page"
        disabled={!ready}
        onPress={() => onCommand({ type: "reload" })}
      />
      <BrowserTabMenu environmentId={environmentId} tab={tab} disabled={!streaming} />
    </View>
  );
}
