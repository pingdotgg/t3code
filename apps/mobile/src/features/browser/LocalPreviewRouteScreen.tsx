import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useRef, useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { useEnvironments } from "../../state/environments";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserBar } from "./BrowserBar";
import { TunnelWebView, type TunnelNavigation, type TunnelWebViewRef } from "./TunnelWebView";

type LocalPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly url: string;
}>;

/** Another environment's localhost page rendered by this device's own webview. */
export function LocalPreviewRouteScreen({ route }: LocalPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const environmentLabel =
    useEnvironments().presentationById.get(environmentId)?.entry.target.label ?? "the environment";
  const { themeVariables } = useAppearancePreferences();
  const webView = useRef<TunnelWebViewRef>(null);
  const [requested, setRequested] = useState(route.params.url);
  const [page, setPage] = useState<TunnelNavigation | null>(null);
  const [failed, setFailed] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  // After a failed load the webview reports no URL, so the address stays on the one asked for.
  const current = (!failed && page?.url) || requested;

  const open = (value: string) => {
    const next = normalizedOrNull(value);
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

  return (
    <View className="flex-1 bg-sheet">
      <BrowserBar
        url={current}
        editable
        canGoBack={page?.canGoBack ?? false}
        onClose={() => navigation.goBack()}
        onBack={() => void webView.current?.goBack()}
        onReload={retry}
        onSubmit={open}
      />
      <View className="flex-1">
        <TunnelWebView
          ref={webView}
          className="flex-1"
          environmentId={environmentId}
          url={route.params.url}
          onNavigationChange={(next) => {
            if (next.loading) setFailed(false);
            setPage(next);
          }}
          onLoadError={(failure) => {
            if (failure.unsupported) return setUnsupported(failure.description);
            // A link to another port fails with that port's address, not the one typed earlier.
            if (failure.url) setRequested(failure.url);
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
                title={`Can't reach ${hostOf(current)}`}
                detail={`Nothing is listening on ${portOf(current)} on ${environmentLabel}. Start the server there, then try again.`}
                actionLabel="Try again"
                onAction={retry}
              />
            </View>
          </View>
        ) : null}
      </View>
    </View>
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

function normalizedOrNull(value: string): string | null {
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}
