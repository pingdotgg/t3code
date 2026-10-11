import {
  Button,
  Column,
  getMaterialColors,
  LazyColumn,
  LinearProgressIndicator,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  background,
  fillMaxSize,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
} from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

type AndroidWidgetEnvironment = WidgetEnvironment & { widgetId?: number };

export function SubscriptionUsage(
  props: SubscriptionUsageProps,
  environment: AndroidWidgetEnvironment,
) {
  "widget";
  // The OS evaluates this function without the app's module scope.
  const now = Date.now();
  const snapshot = props.android?.widgets[String(environment.widgetId)] ?? props.android?.defaults;
  const configuration = snapshot?.configuration;
  const compact = configuration?.density === "compact";
  const scheme =
    configuration?.theme === "light" || configuration?.theme === "dark"
      ? configuration.theme
      : environment.colorScheme === "dark"
        ? "dark"
        : "light";
  const colors = getMaterialColors({ scheme });
  // Cached snapshots from older app versions remain readable until publication.
  const groups =
    snapshot?.groups ??
    (props.providers ?? []).map((provider) => ({
      id: provider.name,
      name: provider.name,
      detail: provider.detail,
      windows: provider.windows.map((window) => ({
        ...window,
        id: window.label,
        resetsAt: null,
        resetDisplay: "reset" as const,
        expiresAt: provider.expiresAt > 0 ? provider.expiresAt : Infinity,
      })),
      totalWindows: provider.totalWindows,
    }));
  const checkedAt = snapshot?.checkedAt ?? props.checkedAt;
  // URL targets use native activity intents, including when the app is closed.
  const usageTarget = props.url ? { target: `url:${props.url}` } : {};
  const configureTarget = props.androidWidgetUrl
    ? {
        target: `url:${props.androidWidgetUrl}${environment.widgetId === undefined ? "" : `?widgetId=${environment.widgetId}`}`,
      }
    : usageTarget;
  return (
    <Column modifiers={[background(colors.surface), fillMaxSize(), paddingAll(compact ? 12 : 16)]}>
      <LazyColumn modifiers={[fillMaxSize()]}>
        {groups.length === 0 ? (
          <Button
            {...configureTarget}
            colors={{ containerColor: colors.surface }}
            onClick={() => {}}
            modifiers={[fillMaxWidth()]}
          >
            <Text color={colors.onSurfaceVariant} style={{ fontSize: 12 }}>
              {snapshot?.emptyMessage ?? "Open T3 to connect and configure usage."}
            </Text>
          </Button>
        ) : null}
        {groups.map((group) => (
          <Button
            key={group.id}
            {...usageTarget}
            colors={{ containerColor: colors.surface }}
            onClick={() => {}}
            modifiers={[fillMaxWidth()]}
          >
            <Column modifiers={[fillMaxWidth(), padding(0, 0, 0, compact ? 6 : 10)]}>
              <Text
                color={colors.onSurface}
                maxLines={2}
                style={{ fontSize: compact ? 12 : 14, fontWeight: "bold" }}
              >
                {group.name}
              </Text>
              {group.detail ? (
                <Text color={colors.onSurfaceVariant} maxLines={2} style={{ fontSize: 10 }}>
                  {group.detail}
                </Text>
              ) : null}
              {group.windows.map((window) => {
                const stale = window.expiresAt <= 0 || now >= window.expiresAt;
                const used = configuration?.percentage === "used";
                const percent = used ? 100 - window.remaining : window.remaining;
                const low = window.remaining <= 10;
                const minutes = Math.max(1, Math.ceil(((window.resetsAt ?? now) - now) / 60_000));
                const days = Math.floor(minutes / 1440);
                const hours = Math.floor((minutes % 1440) / 60);
                const timeLeft = days
                  ? `${days}d ${hours}h`
                  : hours
                    ? `${hours}h ${minutes % 60}m`
                    : `${minutes}m`;
                const reset =
                  !window.resetsAt || window.resetDisplay === "reset"
                    ? window.reset
                    : window.resetDisplay === "both"
                      ? `${window.reset} · ${timeLeft} left`
                      : `Reset in ${timeLeft}`;
                return (
                  <Column
                    key={window.id}
                    modifiers={[fillMaxWidth(), padding(0, compact ? 2 : 5, 0, 0)]}
                  >
                    <Text
                      color={!stale && low ? colors.error : colors.onSurface}
                      maxLines={2}
                      style={{ fontSize: compact ? 10 : 12 }}
                    >
                      {stale
                        ? `${window.label} · Open T3 to refresh`
                        : `${window.label} · ${percent}% ${used ? "used" : "left"}`}
                    </Text>
                    {!stale && configuration?.showBars !== false ? (
                      <Column modifiers={[fillMaxWidth(), padding(0, 3, 0, 3)]}>
                        <LinearProgressIndicator
                          progress={percent / 100}
                          color={low ? colors.error : colors.primary}
                          trackColor={colors.surfaceVariant}
                          modifiers={[fillMaxWidth(), height(compact ? 4 : 6)]}
                        />
                      </Column>
                    ) : null}
                    {!stale && configuration?.showResetTimes !== false ? (
                      <Text color={colors.onSurfaceVariant} maxLines={2} style={{ fontSize: 10 }}>
                        {reset}
                      </Text>
                    ) : null}
                  </Column>
                );
              })}
            </Column>
          </Button>
        ))}
        {configuration?.showUpdatedAt !== false && checkedAt > 0 ? (
          <Text color={colors.onSurfaceVariant} maxLines={2} style={{ fontSize: 10 }}>
            {`As of ${new Date(checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`}
          </Text>
        ) : null}
      </LazyColumn>
    </Column>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
