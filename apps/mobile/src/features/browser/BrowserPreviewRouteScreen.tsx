import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizePreviewUrl, previewPdfAssetUrl } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import { msg, useGT, useMessages } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { m } from "../../i18n/messages";
import { useAppForeground } from "../../lib/appState";

import { useThreadBrowserTabs } from "../../state/preview";
import { usePreparedConnection } from "../../state/session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserChrome } from "./BrowserBar";
import { BrowserTabMenu } from "./BrowserTabMenu";
import { browserTabTitle, browserTabUrl, latestBrowserTab } from "./browserTabs";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "./PreviewStreamWebView";

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
}>;

export function BrowserPreviewRouteScreen({ route }: BrowserPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  if (!environmentId?.trim() || !threadId?.trim()) {
    return <BrowserUnavailableScreen onClose={onClose} />;
  }
  return (
    <BrowserPreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialTabId={route.params.tabId ?? null}
      onClose={onClose}
    />
  );
}

function BrowserUnavailableScreen({ onClose }: { readonly onClose: () => void }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: contentTopInset, paddingBottom: insets.bottom }}
    >
      <SheetHeader
        title={gt("Browser", { $context: "screen title" })}
        onClose={onClose}
        accessibilityLabel={gt("Close browser")}
      />
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
  const gt = useGT();
  const resolveMessage = useMessages();
  const { themeVariables } = useAppearancePreferences();
  const prepared = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedTabId, setSelectedTabId] = useState(initialTabId);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  const [streaming, setStreaming] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const streamRef = useRef<PreviewStreamRef>(null);
  const { tabs, loaded } = useThreadBrowserTabs({ environmentId, threadId, enabled: true });
  const tab = tabs.find((entry) => entry.tabId === selectedTabId) ?? latestBrowserTab(tabs);
  const pdfUri =
    tab?.navStatus._tag === "Success" ? previewPdfAssetUrl(tab.navStatus.url, httpBaseUrl) : null;
  const tabId = tab?.tabId ?? null;
  if (tabId !== null && tabId !== selectedTabId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(tabId);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the focused route through the navigator once the thread has no browser tabs left
  useEffect(() => {
    if (focused && loaded && tabs.length === 0) onClose();
  }, [focused, loaded, tabs.length, onClose]);
  const onPictureInPicture = (state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Dialog.alert(m(msg("Picture in picture is unavailable")), detail);
  };
  const selectTab = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(next);
  };
  const live = (focused && foreground) || pictureInPicture.active;

  const ready = streaming && canControl;
  const command: PreviewStreamRef["command"] = (input) => streamRef.current?.command(input);
  const showPictureInPicture =
    // Android WebView cannot play video in picture in picture.
    Platform.OS === "ios" &&
    pictureInPicture.supported &&
    (pictureInPicture.active || pdfUri === null);

  return (
    // The route spans the Duo's rail, so the screen insets its own sides.
    <SafeAreaView
      edges={["left", "right"]}
      style={{ flex: 1, backgroundColor: themeVariables["--color-sheet-solid"] }}
    >
      <BrowserChrome
        key={tab ? `address:${tab.tabId}` : "address"}
        scrollsUnderBar={false}
        bar={{
          url: tab ? browserTabUrl(tab) : "",
          editable: ready,
          canGoBack: ready && (tab?.canGoBack ?? false),
          onClose,
          onBack: () => command({ type: "history", delta: -1 }),
          onReload: () => command({ type: "reload" }),
          onSubmit: (value) => {
            const url = normalizedOrNull(value);
            if (url === null)
              Dialog.alert(
                m(msg("Could not open this address")),
                m(msg("Enter an http or https URL.")),
              );
            else command({ type: "navigate", url });
          },
          trailing: (
            <>
              {showPictureInPicture ? (
                <ControlPill
                  icon={{
                    ios: pictureInPicture.active ? "pip.exit" : "pip.enter",
                    android: "visibility",
                  }}
                  accessibilityLabel={
                    pictureInPicture.active
                      ? gt("Exit picture in picture")
                      : gt("Picture in picture")
                  }
                  onPress={() => streamRef.current?.togglePictureInPicture()}
                />
              ) : null}
              {tabs.length > 1 ? (
                <Menu
                  accessible
                  accessibilityLabel={gt("Tabs", { $context: "browser tabs menu" })}
                  accessibilityRole="button"
                  actions={tabs.map((entry) => ({
                    id: entry.tabId,
                    title: browserTabTitle(entry, resolveMessage),
                    subtitle: browserTabUrl(entry),
                    state: entry.tabId === tabId ? "on" : "off",
                  }))}
                  onPressAction={({ nativeEvent }) => selectTab(nativeEvent.event)}
                >
                  <ControlPill
                    icon="square.on.square"
                    accessibilityLabel={gt("Tabs", { $context: "browser tabs menu" })}
                  />
                </Menu>
              ) : null}
              {tab ? (
                <BrowserTabMenu
                  environmentId={environmentId}
                  tab={tab}
                  streaming={streaming}
                  onPaste={ready ? () => streamRef.current?.paste() : undefined}
                  onReleaseControl={ready ? () => command({ type: "releaseControl" }) : undefined}
                />
              ) : null}
            </>
          ),
        }}
      >
        {({ onScrollDirection }) =>
          tab ? (
            live ? (
              <PreviewStreamWebView
                key={`stream:${tab.tabId}`}
                environmentId={environmentId}
                threadId={threadId}
                tabId={tab.tabId}
                pdfUri={pdfUri}
                ref={streamRef}
                interactive
                background={themeVariables["--color-sheet-solid"]}
                onPictureInPicture={onPictureInPicture}
                onStreamingChange={setStreaming}
                onScrollDirection={onScrollDirection}
                onControl={(control) => setCanControl(control?.controller === "you")}
              />
            ) : (
              <View className="flex-1" />
            )
          ) : (
            <View className="flex-1 items-center justify-center">
              {focused && foreground ? (
                <AppActivityIndicator color={themeVariables["--color-icon"]} />
              ) : null}
            </View>
          )
        }
      </BrowserChrome>
    </SafeAreaView>
  );
}

function normalizedOrNull(value: string): string | null {
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}
