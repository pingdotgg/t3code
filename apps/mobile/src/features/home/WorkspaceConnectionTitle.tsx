import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import {
  brandTitleOffset,
  CompactBrandTitle,
  getCompactBrandHeaderOptions,
} from "../../components/CompactBrandTitle";
import { useWorkspaceState } from "../../state/workspace";
import {
  workspaceConnectionStatusPresentation,
  type WorkspaceConnectionStatusPresentation,
} from "./workspace-connection-status";

/**
 * Delay before a connection interruption surfaces in the title slot. Sub-second
 * blips (the common reconnect case) resolve without any UI at all.
 */
const STATUS_SHOW_DELAY_MS = 800;
const FADE_IN_MS = 250;

/**
 * Connection status presentation, debounced for display: null until the
 * workspace has been in a non-connected state for STATUS_SHOW_DELAY_MS,
 * then live-updating until the workspace reconnects (null again immediately).
 */
function useDelayedConnectionStatus(): WorkspaceConnectionStatusPresentation | null {
  const { state } = useWorkspaceState();
  const presentation = workspaceConnectionStatusPresentation(state);
  const hasStatus = presentation !== null;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!hasStatus) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), STATUS_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasStatus]);

  return visible ? presentation : null;
}

/**
 * One-shot entrance fade for the status label. Deliberately JS-driven: this can
 * mount inside a native header item (RNSScreenStackHeaderSubview), where
 * native-driver animated nodes blank the re-hosted view entirely. The JS driver
 * updates opacity through the ordinary style path, which those subviews handle.
 */
function StatusFadeIn(props: {
  readonly children: ReactNode;
  readonly grow?: boolean;
  readonly maxWidth?: number;
}) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      duration: FADE_IN_MS,
      toValue: 1,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        { alignItems: "center", flexDirection: "row", maxWidth: props.maxWidth, opacity },
        props.grow ? { flex: 1, minWidth: 0 } : null,
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

/**
 * Renders the brand/title slot of a thread-list surface, swapping the brand
 * for the workspace connection status while an environment is unavailable.
 *
 * Both states occupy the same slot, so connection changes never shift the
 * layout below. While connected the brand renders untouched — no wrapper —
 * keeping the native header item on the exact element tree that predates the
 * status swap. Replaces the old WorkspaceConnectionStatus pill, which inserted
 * a row above the thread list.
 */
export function WorkspaceConnectionTitle(props: {
  /** Content shown while connected (brand lockup or a screen title). */
  readonly brand: ReactNode;
  /** Opens environment settings. Status is not pressable when omitted. */
  readonly onPress?: () => void;
  /** Fill the available row width (in-flow headers) instead of hugging content (native title slots). */
  readonly grow?: boolean;
  readonly size?: "navbar" | "pageTitle";
  /** Horizontal correction so the status aligns with the brand in native title slots. */
  readonly statusOffset?: number;
  /** Space available beside the native header actions. */
  readonly maxWidth?: number;
}) {
  const status = useDelayedConnectionStatus();
  const size = props.size ?? "navbar";

  if (status === null) {
    return props.grow ? (
      <View style={{ alignItems: "center", flex: 1, flexDirection: "row", minWidth: 0 }}>
        {props.brand}
      </View>
    ) : (
      <>{props.brand}</>
    );
  }

  return (
    <StatusFadeIn grow={props.grow} maxWidth={props.maxWidth}>
      <Pressable
        accessibilityHint="Opens environment settings"
        accessibilityLabel={status.label}
        accessibilityRole="button"
        disabled={props.onPress === undefined}
        hitSlop={8}
        onPress={props.onPress}
        className="flex-row items-center gap-2"
        style={{ flexShrink: 1, marginLeft: props.statusOffset ?? 0 }}
      >
        {status.showsProgress ? (
          <ActivityIndicator colorClassName={"accent-icon-muted"} size="small" />
        ) : (
          <SymbolView
            name="wifi.slash"
            size={size === "pageTitle" ? 17 : 15}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}
        <Text
          className={
            size === "pageTitle"
              ? "text-[20px] font-t3-bold text-foreground-muted"
              : "text-[16px] font-t3-bold text-foreground-muted"
          }
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {status.label}
        </Text>
      </Pressable>
    </StatusFadeIn>
  );
}

/**
 * getCompactBrandHeaderOptions with the brand slot upgraded to the
 * connection-status swap. Screens with an environment-settings callback apply
 * this over the static brand options at mount.
 */
export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
}): NativeStackNavigationOptions {
  // Leave room for bar margins, title spacing and the 44-point native actions.
  // Long status labels must not push Settings into UIKit's overflow menu.
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  return {
    ...getCompactBrandHeaderOptions(opts.fallbackTitleStyle),
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle />}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        statusOffset={brandTitleOffset()}
      />
    ),
  };
}
