import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
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

type ConnectionStatus = WorkspaceConnectionStatusPresentation & {
  /** Only while the status first appears. A header that shows it later shows it at once. */
  readonly fadeIn: boolean;
};

const ConnectionStatusContext = createContext<ConnectionStatus | null>(null);

/**
 * The delay hides brief reconnects, so it is the workspace's, not each header's: every header
 * shows the status from the same moment. Headers read it from context instead of subscribing
 * themselves, because a hidden Android tab drops its subscriptions and showed a stale status for
 * a moment when it came back, while context still reaches it.
 */
export function WorkspaceConnectionStatusProvider(props: { readonly children: ReactNode }) {
  const { state } = useWorkspaceState();
  const presentation = workspaceConnectionStatusPresentation(state);
  const hasStatus = presentation !== null;
  const [phase, setPhase] = useState<"waiting" | "fading" | "shown">("waiting");

  useEffect(() => {
    if (!hasStatus) return;
    const timers = [
      setTimeout(() => setPhase("fading"), STATUS_SHOW_DELAY_MS),
      setTimeout(() => setPhase("shown"), STATUS_SHOW_DELAY_MS + FADE_IN_MS),
    ];
    return () => {
      for (const timer of timers) clearTimeout(timer);
      setPhase("waiting");
    };
  }, [hasStatus]);

  const label = presentation?.label;
  const showsProgress = presentation?.showsProgress ?? false;
  const status = useMemo(
    () =>
      label === undefined || phase === "waiting"
        ? null
        : { label, showsProgress, fadeIn: phase === "fading" },
    [label, showsProgress, phase],
  );
  return <ConnectionStatusContext value={status}>{props.children}</ConnectionStatusContext>;
}

/** Native-driver animation blanks views re-hosted in RNSScreenStackHeaderSubview; use the JS style path. */
function StatusFadeIn(props: {
  readonly children: ReactNode;
  readonly animate: boolean;
  readonly grow?: boolean;
  readonly maxWidth?: number;
}) {
  const { animate } = props;
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!animate) return;
    const animation = Animated.timing(opacity, {
      duration: FADE_IN_MS,
      toValue: 1,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [animate, opacity]);

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          flexDirection: "row",
          maxWidth: props.maxWidth,
          // A hidden tab never runs the fade, so its value would still be 0 when the tab returns.
          opacity: animate ? opacity : 1,
        },
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
  const status = use(ConnectionStatusContext);
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
    <StatusFadeIn animate={status.fadeIn} grow={props.grow} maxWidth={props.maxWidth}>
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
