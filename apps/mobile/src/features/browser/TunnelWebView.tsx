import type { EnvironmentId } from "@t3tools/contracts";
import { requireNativeModule, requireNativeView } from "expo";
import { useRef, type Ref } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { readPreviewTunnelUrl } from "../../state/previewTunnel";

export interface TunnelNavigation {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface TunnelWebViewRef {
  readonly loadUrl: (url: string) => Promise<void>;
  readonly goBack: () => Promise<void>;
  readonly goForward: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

const PreviewTunnel = requireNativeModule<{
  resolveAccess(requestId: string, url: string | null): void;
}>("T3PreviewTunnel");

const NativeTunnelWebView = requireNativeView<
  ViewProps & {
    readonly ref?: Ref<TunnelWebViewRef>;
    readonly environmentId: string;
    readonly url: string;
    readonly onAccessRequest: (event: NativeSyntheticEvent<{ requestId: string }>) => void;
    readonly onNavigationChange: (event: NativeSyntheticEvent<TunnelNavigation>) => void;
    readonly onLoadError: (
      event: NativeSyntheticEvent<{
        code: number;
        description: string;
        url: string;
        debug?: string;
      }>,
    ) => void;
    readonly onPageScroll: (event: NativeSyntheticEvent<{ y: number }>) => void;
  }
>("T3PreviewTunnel");

/** A native webview whose localhost is the environment's loopback, reached through its tunnel. */
export function TunnelWebView({
  environmentId,
  url,
  ref,
  onNavigationChange,
  onLoadError,
  onScrollDirection,
  onAccess,
  ...props
}: ViewProps & {
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly ref?: Ref<TunnelWebViewRef>;
  readonly onNavigationChange: (navigation: TunnelNavigation) => void;
  /**
   * `url` is the address that failed, or empty when the platform does not report it.
   * `unsupported` means this device's webview cannot route localhost at all.
   */
  readonly onLoadError: (failure: {
    readonly url: string;
    readonly unsupported: boolean;
    readonly description: string;
    /** TEMPORARY: what the native proxy saw, while we debug real devices. */
    readonly debug?: string;
  }) => void;
  /** Whether the last connection could get into the environment's tunnel at all. */
  readonly onAccess?: (available: boolean) => void;
  /** Reported every few dozen points the page scrolls; "up" also at the top. */
  readonly onScrollDirection?: (direction: "up" | "down") => void;
}) {
  const scrollY = useRef(0);
  // Styling goes on a plain View: a native view from `requireNativeView` ignores className.
  return (
    <View {...props}>
      <NativeTunnelWebView
        style={StyleSheet.absoluteFill}
        ref={ref}
        environmentId={environmentId}
        url={url}
        onAccessRequest={({ nativeEvent }) => {
          void readPreviewTunnelUrl(environmentId).then((tunnelUrl) => {
            onAccess?.(tunnelUrl !== null);
            PreviewTunnel.resolveAccess(nativeEvent.requestId, tunnelUrl);
          });
        }}
        onNavigationChange={({ nativeEvent }) => onNavigationChange(nativeEvent)}
        onPageScroll={({ nativeEvent }) => {
          const down = nativeEvent.y > 0 && nativeEvent.y > scrollY.current;
          scrollY.current = nativeEvent.y;
          onScrollDirection?.(down ? "down" : "up");
        }}
        onLoadError={({ nativeEvent }) =>
          onLoadError({
            url: nativeEvent.url,
            // The view reports a setup failure with no URL and code -1, before any page loads.
            unsupported: nativeEvent.code === -1 && nativeEvent.url === "",
            description: nativeEvent.description,
            debug: nativeEvent.debug,
          })
        }
      />
    </View>
  );
}
