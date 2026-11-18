import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useEnvironments } from "../../state/environments";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserBar, useBarFollowsScroll } from "./BrowserBar";
import { loopbackUrlForDevice } from "./browserTabs";
import { TunnelWebView, type TunnelNavigation, type TunnelWebViewRef } from "./TunnelWebView";

type LocalPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly url: string;
}>;

export function LocalPreviewRouteScreen({ route }: LocalPreviewRouteScreenProps) {
  const navigation = useNavigation();
  return (
    <LocalPreviewScreen
      environmentId={EnvironmentId.make(route.params.environmentId)}
      url={route.params.url}
      onClose={() => navigation.goBack()}
    />
  );
}

/**
 * Another environment's localhost page rendered by this device's own webview. Full screen it has
 * an editable address bar; in the inspector pane, `onMaximize` gives it the pane's bar instead.
 */
export function LocalPreviewScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly onClose: () => void;
  readonly onMaximize?: (url: string) => void;
}) {
  const { environmentId, onMaximize } = props;
  const initialUrl = forDevice(props.url);
  const environmentLabel =
    useEnvironments().presentationById.get(environmentId)?.entry.target.label ?? "the environment";
  const { themeVariables } = useAppearancePreferences();
  const barOverlap = useBarOverlap();
  const webView = useRef<TunnelWebViewRef>(null);
  const [requested, setRequested] = useState(initialUrl);
  const [page, setPage] = useState<TunnelNavigation | null>(null);
  const [failed, setFailed] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [debug, setDebug] = useState<string | undefined>(undefined);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const bar = useBarFollowsScroll();
  // After a failed load the webview reports no URL, so the address stays on the one asked for.
  const current = (!failed && page?.url) || requested;

  const open = (value: string) => {
    const normalized = normalizedOrNull(value);
    const next = normalized === null ? null : forDevice(normalized);
    if (next === null) {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
      return;
    }
    setFailed(false);
    setRequested(next);
    void webView.current?.loadUrl(next);
  };
  const retry = () => {
    setFailed(false);
    void webView.current?.reload();
  };
  const back = () => void webView.current?.goBack();
  const canGoBack = page?.canGoBack ?? false;
  // Like Safari, full screen on iOS lays the bar over the page, which scrolls under it.
  const overlay = Platform.OS === "ios" && !onMaximize;
  const [barHeight, setBarHeight] = useState(0);
  const compact = bar.compact && !failed;
  // Safari on the Duo hides the status band with its bar; other iPhones keep the clock.
  const duo = isDuoDevice(useDeviceType());
  const hideStatusBar = overlay && compact && duo;
  const navigation = useNavigation();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the status bar is a native screen option
  useEffect(() => {
    if (!overlay) return;
    navigation.setOptions({ statusBarHidden: hideStatusBar, statusBarAnimation: "fade" });
  }, [navigation, overlay, hideStatusBar]);
  const pageColor = failed || unsupported !== null ? null : page?.pageColor || null;
  const browserBar = (
    <BrowserBar
      url={current}
      editable
      canGoBack={canGoBack}
      onClose={props.onClose}
      onBack={back}
      onReload={retry}
      onSubmit={open}
      compact={compact}
      onExpand={bar.expand}
      pageColor={pageColor}
    />
  );

  return (
    // Full screen spans the Duo's rail, so it insets its own sides; the pane is inset already.
    <SafeAreaView
      edges={onMaximize ? [] : ["left", "right"]}
      style={{ flex: 1, backgroundColor: pageColor ?? themeVariables["--color-sheet-solid"] }}
    >
      {onMaximize ? (
        <>
          <AppBar
            title={page?.title || hostOf(current)}
            subtitle={hostOf(current)}
            actions={[
              ...(canGoBack
                ? [{ accessibilityLabel: "Back", icon: "chevron.left" as const, onPress: back }]
                : []),
              {
                accessibilityLabel: "Reload page",
                icon: "arrow.clockwise" as const,
                onPress: retry,
              },
              {
                accessibilityLabel: "Maximize page",
                icon: "arrow.up.left.and.arrow.down.right",
                onPress: () => onMaximize(current),
              },
            ]}
          />
          <View style={{ height: barOverlap }} />
        </>
      ) : overlay ? null : (
        browserBar
      )}
      <View className="flex-1">
        <TunnelWebView
          key={environmentId}
          ref={webView}
          className="flex-1"
          environmentId={environmentId}
          url={initialUrl}
          topInset={overlay ? barHeight : 0}
          onNavigationChange={(next) => {
            if (next.loading) setFailed(false);
            setPage(next);
          }}
          onScrollDirection={onMaximize ? undefined : bar.follow}
          onAccess={(available) => setDisconnected(!available)}
          onLoadError={(failure) => {
            if (failure.unsupported) return setUnsupported(failure.description);
            // A link to another port fails with that port's address, not the one typed earlier.
            if (failure.url) setRequested(failure.url);
            setDebug(failure.debug);
            setFailed(true);
          }}
        />
        {unsupported !== null ? (
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}
          >
            <View className="w-full max-w-md">
              <EmptyState
                variant="plain"
                title="This device can't open localhost pages"
                detail={`${unsupported} You can still use the streamed browser for this tab.`}
              />
            </View>
          </View>
        ) : failed ? (
          // Opaque, so the webview's own error page never shows through the sheet color.
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}
          >
            <View className="w-full max-w-md">
              <EmptyState
                variant="plain"
                title={
                  disconnected
                    ? `Not connected to ${environmentLabel}`
                    : `Can't reach ${hostOf(current)}`
                }
                detail={
                  disconnected
                    ? `Pages on ${environmentLabel}'s localhost load through its connection. Try again once it reconnects.`
                    : `Nothing is listening on ${portOf(current)} on ${environmentLabel}. Start the server there, then try again.`
                }
                actionLabel="Try again"
                onAction={retry}
              />
              {debug ? (
                <AppText
                  selectable
                  className="px-6 text-center font-mono text-xs text-foreground-muted"
                >
                  {debug}
                </AppText>
              ) : null}
            </View>
          </View>
        ) : null}
        {overlay ? (
          <View
            className="absolute inset-x-0 top-0"
            onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
          >
            {browserBar}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function portOf(value: string): string {
  try {
    const url = new URL(value);
    return `port ${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "this port";
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

// The unspecified address would name the phone itself, so it becomes the environment's localhost.
function forDevice(url: string): string {
  return loopbackUrlForDevice(url) ?? url;
}

function normalizedOrNull(value: string): string | null {
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}
