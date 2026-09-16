import {
  Button,
  Column,
  getMaterialColors,
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

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

export function SubscriptionUsage(props: SubscriptionUsageProps, environment: WidgetEnvironment) {
  "widget";
  // The widget runtime evaluates this function without the app's module scope.
  // Android has no timeline, so freshness is decided on every render; the
  // expiry alarm and each tap trigger one while the app is closed.
  const now = Date.now();
  // The 4x3 default cell fits two quotas per provider with their reset text.
  const limit = 2;
  const colors = getMaterialColors({
    scheme: environment.colorScheme === "dark" ? "dark" : "light",
  });
  const muted = colors.onSurfaceVariant;
  const providers = props.providers ?? [
    { name: "Codex", detail: "Open T3 to connect", windows: [], expiresAt: 0, totalWindows: 0 },
    { name: "Claude", detail: "Open T3 to connect", windows: [], expiresAt: 0, totalWindows: 0 },
  ];
  return (
    // The card is one Button so a tap reaches the app's interaction listener,
    // which opens props.url. expo-widgets has no Android counterpart to widgetURL.
    <Button colors={{ containerColor: colors.surface }} modifiers={[fillMaxSize()]}>
      <Column modifiers={[fillMaxSize(), paddingAll(16)]}>
        {providers.map((provider, index) => {
          const stale = provider.windows.length > 0 && now >= provider.expiresAt;
          const shown = stale ? [] : provider.windows.slice(0, limit);
          const hidden = stale ? 0 : (provider.totalWindows ?? provider.windows.length) - limit;
          return (
            <Column
              key={provider.name}
              modifiers={[fillMaxWidth(), padding(0, index === 0 ? 0 : 10, 0, 0)]}
            >
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
              {shown.map((window) => {
                const low = window.remaining <= 10;
                return (
                  <Column key={window.label} modifiers={[fillMaxWidth(), padding(0, 4, 0, 0)]}>
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
                  </Column>
                );
              })}
              {hidden > 0 ? (
                <Text color={muted} maxLines={1} style={{ fontSize: 10 }}>
                  {`${hidden} more in T3`}
                </Text>
              ) : null}
            </Column>
          );
        })}
        <Text
          color={muted}
          maxLines={1}
          style={{ fontSize: 10 }}
          modifiers={[padding(0, 10, 0, 0)]}
        >
          {props.checkedAt
            ? `As of ${new Date(props.checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`
            : "Tap to connect in T3"}
        </Text>
      </Column>
    </Button>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
