import {
  Button,
  Column,
  getMaterialColors,
  LazyColumn,
  LinearProgressIndicator,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  fillMaxSize,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
} from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { ReactNode } from "react";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

export function SubscriptionUsage(props: SubscriptionUsageProps, environment: WidgetEnvironment) {
  "widget";
  // The widget runtime evaluates this function without the app's module scope.
  const now = Date.now();
  const mode = props.theme?.mode;
  const appearance =
    mode === "light" || mode === "dark"
      ? mode
      : environment.colorScheme === "dark"
        ? "dark"
        : "light";
  const palette = props.theme?.[appearance];
  const colors = palette
    ? {
        surface: palette.background,
        onSurface: palette.foreground,
        onSurfaceVariant: palette.secondary,
        surfaceVariant: palette.track,
        primary: palette.accent,
        error: palette.danger,
      }
    : getMaterialColors({ scheme: appearance });
  const muted = colors.onSurfaceVariant;
  const providers = props.providers ?? [
    { name: "Codex", detail: "Open T3 to connect", windows: [], expiresAt: 0, totalWindows: 0 },
    { name: "Claude", detail: "Open T3 to connect", windows: [], expiresAt: 0, totalWindows: 0 },
  ];
  const rows = providers.map((provider) => {
    const stale =
      provider.windows.length > 0 && provider.expiresAt > 0 && now >= provider.expiresAt;
    return { provider, stale, shown: stale ? [] : provider.windows };
  });
  // Placeholders such as "Open T3 to refresh" are not limits.
  const limits = rows.reduce((total, row) => total + row.shown.length, 0);
  // A scrolling list swallows taps meant for the card behind it, so each item is its own tap target.
  const tappable = (key: string, child: ReactNode) => (
    <Button key={key} modifiers={[fillMaxWidth()]} onClick={() => {}}>
      {child}
    </Button>
  );
  return (
    // Android lacks widgetURL; one card Button routes taps to the app listener opening props.url.
    <Button
      colors={{ containerColor: colors.surface }}
      modifiers={[fillMaxSize()]}
      onClick={() => {}}
    >
      <Column modifiers={[fillMaxSize(), paddingAll(16)]}>
        <Text color={colors.onSurface} maxLines={1} style={{ fontSize: 16, fontWeight: "bold" }}>
          {limits > 0 ? `Subscription usage (${limits})` : "Subscription usage"}
        </Text>
        <LazyColumn modifiers={[fillMaxWidth()]}>
          {rows.flatMap(({ provider, shown, stale }, index) => [
            tappable(
              provider.name,
              <Column modifiers={[fillMaxWidth(), padding(0, index === 0 ? 0 : 10, 0, 0)]}>
                <Text
                  color={colors.onSurface}
                  maxLines={1}
                  style={{ fontSize: 13, fontWeight: "bold" }}
                >
                  {provider.name}
                </Text>
                {shown.length === 0 ? (
                  <Text color={muted} maxLines={1} style={{ fontSize: 11 }}>
                    {stale ? "Open T3 to refresh" : provider.detail}
                  </Text>
                ) : null}
              </Column>,
            ),
            ...shown.map((window) => {
              const low = window.remaining <= 10;
              return tappable(
                `${provider.name}:${window.label}`,
                <Column modifiers={[fillMaxWidth(), padding(0, 4, 0, 0)]}>
                  <Text
                    color={low ? colors.error : colors.onSurface}
                    maxLines={1}
                    style={{ fontSize: 11 }}
                  >
                    {`${window.label} · ${window.remaining}% left`}
                  </Text>
                  <Column modifiers={[fillMaxWidth(), padding(0, 3, 0, 3)]}>
                    <LinearProgressIndicator
                      progress={window.remaining / 100}
                      color={low ? colors.error : colors.primary}
                      trackColor={colors.surfaceVariant}
                      modifiers={[fillMaxWidth(), height(6)]}
                    />
                  </Column>
                  <Text color={muted} maxLines={1} style={{ fontSize: 10 }}>
                    {window.reset}
                  </Text>
                </Column>,
              );
            }),
          ])}
          {/* The runtime ignores weight, so a footer after the list would be pushed out of the card. */}
          {/* A Button holding bare text renders as a Material button; a Column keeps it a plain tap target. */}
          {tappable(
            "checked",
            <Column modifiers={[fillMaxWidth(), padding(0, 10, 0, 0)]}>
              <Text color={muted} maxLines={1} style={{ fontSize: 10 }}>
                {props.checkedAt
                  ? `Last checked ${new Date(props.checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`
                  : "Tap to connect in T3"}
              </Text>
            </Column>,
          )}
        </LazyColumn>
      </Column>
    </Button>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
