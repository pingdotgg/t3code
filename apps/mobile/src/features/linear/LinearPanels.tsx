import type { LinearDegradation } from "@t3tools/client-runtime/linear/degradation";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { LinearTabState } from "./linearEnvironment";
import { LinearGlyph } from "./linearIcons";

const BANNER_COPY: Record<LinearDegradation, string> = {
  rate_limited: "Linear rate limit hit. Showing cached data.",
  unavailable: "Couldn't reach Linear. Showing cached data.",
};

/** Cached-data banner; the screen keeps rendering whatever it has underneath it. */
export function LinearBanner(props: {
  readonly degradation: LinearDegradation;
  readonly onRetry: () => void;
  readonly retrying: boolean;
}) {
  return (
    <View
      accessibilityRole="alert"
      className="mx-4 mb-2 flex-row items-center gap-3 rounded-2xl border border-warning-border bg-warning px-3.5 py-2.5"
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={16}
        tintColorClassName="accent-warning-foreground"
      />
      <Text className="min-w-0 flex-1 text-sm text-warning-foreground">
        {BANNER_COPY[props.degradation]}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry"
        accessibilityState={{ disabled: props.retrying, busy: props.retrying }}
        disabled={props.retrying}
        onPress={props.onRetry}
        hitSlop={12}
        className="active:opacity-60"
      >
        <Text className="text-sm font-t3-bold text-warning-foreground">
          {props.retrying ? "Retrying…" : "Retry"}
        </Text>
      </Pressable>
    </View>
  );
}

const NOT_CONNECTED_COPY: Record<
  Exclude<LinearTabState, "connected" | "loading">,
  { readonly title: string; readonly detail: string }
> = {
  "no-environment": {
    title: "No environment connected",
    detail: "Connect to an environment in Settings to browse its Linear issues.",
  },
  unsupported: {
    title: "Linear isn't available yet",
    detail: "This server doesn't support Linear yet. Update T3 Code on the server.",
  },
  disconnected: {
    title: "Connect Linear",
    detail: "Connect Linear from T3 Code on your computer: Settings → Integrations → Linear.",
  },
  invalid: {
    title: "Reconnect Linear",
    detail:
      "Your Linear API key is no longer valid. Update it from T3 Code on your computer (Settings → Integrations → Linear).",
  },
  unreachable: {
    title: "Couldn't reach Linear",
    detail: "Check the connection to this environment and try again.",
  },
};

/** Linear can't be browsed from here; mobile never takes the API key (set up on web/desktop). */
export function LinearNotConnected(props: {
  readonly state: Exclude<LinearTabState, "connected" | "loading">;
  readonly onRetry?: () => void;
}) {
  const copy = NOT_CONNECTED_COPY[props.state];
  const showMark = props.state === "disconnected" || props.state === "invalid";
  return (
    <View className="items-center px-8 py-12">
      {showMark ? (
        <View className="mb-5 size-14 items-center justify-center rounded-2xl border border-border bg-card">
          <LinearGlyph size={26} />
        </View>
      ) : null}
      <EmptyState
        variant="plain"
        title={copy.title}
        detail={copy.detail}
        {...(props.state === "unreachable" && props.onRetry
          ? { actionLabel: "Retry", onAction: props.onRetry }
          : {})}
      />
    </View>
  );
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e"] as const;

/** Placeholder rows while a list loads, like the pull request overview's. */
export function LinearListSkeleton(props: { readonly label: string }) {
  return (
    <View
      className="gap-3 px-4 py-3"
      accessibilityLabel={props.label}
      accessibilityState={{ busy: true }}
    >
      {SKELETON_ROWS.map((row) => (
        <View key={row} className="gap-2">
          <View className="h-3 w-24 rounded bg-subtle-strong" />
          <View className="h-4 w-full rounded bg-subtle-strong" />
        </View>
      ))}
    </View>
  );
}

export function LinearListError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="items-center gap-3 px-8 py-8">
      <Text className="text-center text-sm text-foreground-muted">{props.message}</Text>
      <Button label="Retry" onPress={props.onRetry} />
    </View>
  );
}

export function LinearSectionTitle(props: { readonly children: ReactNode }) {
  return (
    <Text className="px-4 pt-4 pb-2 text-xs font-t3-bold tracking-wide text-foreground-muted uppercase">
      {props.children}
    </Text>
  );
}
