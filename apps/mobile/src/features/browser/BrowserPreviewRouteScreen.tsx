import { Toolbar } from "../../components/ui/Toolbar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ui/ControlPill";
import { AppBar } from "../../components/ui/AppBar";

import { useThreadServerBrowserTabs } from "../../state/preview";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserTabMenu } from "./BrowserTabMenu";
import { browserTabTitle, browserTabUrl, latestBrowserTab } from "./browserTabs";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "./PreviewStreamWebView";

const BrowserPreviewStack = createNativeStackNavigator<{ BrowserPreview: undefined }>();

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
}>;

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
  const [streaming, setStreaming] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const streamRef = useRef<PreviewStreamRef>(null);
  const { tabs, loaded } = useThreadServerBrowserTabs({ environmentId, threadId, enabled: true });
  const tab = tabs.find((entry) => entry.tabId === selectedTabId) ?? latestBrowserTab(tabs);
  const tabId = tab?.tabId ?? null;
  if (tabId !== null && tabId !== selectedTabId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
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
    if (detail) Dialog.alert("Picture in picture is unavailable", detail);
  }, []);
  const selectTab = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(next);
  };
  const live = (focused && foreground) || pictureInPicture.active;

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <AppBar
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
        <Toolbar placement="left">
          <Toolbar.Button
            icon="xmark"
            accessibilityLabel="Close browser"
            onPress={onClose}
            separateBackground
          />
        </Toolbar>
      ) : null}
      {tab ? (
        <>
          <BrowserAddressBar
            key={`address:${tab.tabId}`}
            environmentId={environmentId}
            tab={tab}
            streaming={streaming}
            ready={streaming && canControl}
            onCommand={(input) => streamRef.current?.command(input)}
          />
          {live ? (
            <PreviewStreamWebView
              key={`stream:${tab.tabId}`}
              environmentId={environmentId}
              threadId={threadId}
              tabId={tab.tabId}
              ref={streamRef}
              interactive
              background={themeVariables["--color-sheet-solid"]}
              onPictureInPicture={onPictureInPicture}
              onStreamingChange={setStreaming}
              onControl={(control) => setCanControl(control?.controller === "you")}
            />
          ) : (
            <View className="flex-1" />
          )}
        </>
      ) : (
        <View className="flex-1 items-center justify-center">
          {focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
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
  readonly ready: boolean;
  readonly streaming: boolean;
  readonly onCommand: PreviewStreamRef["command"];
}) {
  const url = browserTabUrl(tab);
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const value = draft ?? url;
    setDraft(null);
    try {
      onCommand({ type: "navigate", url: normalizePreviewUrl(value) });
    } catch {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
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
        lineBreakModeIOS="tail"
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
