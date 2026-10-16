import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Platform, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
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

const STATUS_SHOW_DELAY_MS = 800;
const FADE_IN_MS = 250;

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
 * Deliberately JS-driven: this can mount inside a native header item
 * (RNSScreenStackHeaderSubview), where native-driver animated nodes blank the
 * re-hosted view entirely. The JS driver updates opacity through the ordinary
 * style path, which those subviews handle.
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

export function WorkspaceConnectionTitle(props: {
  readonly brand: ReactNode;
  readonly onPress?: () => void;
  readonly grow?: boolean;
  readonly size?: "navbar" | "pageTitle";
  readonly statusOffset?: number;
  readonly maxWidth?: number;
}) {
  const status = useDelayedConnectionStatus();
  const size = props.size ?? "navbar";
  const { scale } = useAndroidControlSizing();

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
        style={[
          { flexShrink: 1, marginLeft: props.statusOffset ?? 0 },
          Platform.OS === "android" && { gap: 7 * scale },
        ]}
      >
        {status.showsProgress ? (
          <AppActivityIndicator
            colorClassName={"accent-icon-muted"}
            size={Platform.OS === "android" ? Math.round(20 * scale) : "small"}
          />
        ) : (
          <SymbolView
            name="wifi.slash"
            size={Math.round((size === "pageTitle" ? 17 : 15) * scale)}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}
        <Text
          className="font-t3-bold text-foreground-muted"
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: (size === "pageTitle" ? 20 : 16) * scale }}
        >
          {status.label}
        </Text>
      </Pressable>
    </StatusFadeIn>
  );
}

export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
}): NativeStackNavigationOptions {
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
