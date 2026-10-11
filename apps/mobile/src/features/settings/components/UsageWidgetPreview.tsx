import { getMaterialColors } from "@expo/ui/jetpack-compose";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";

import { AppText as Text } from "../../../components/AppText";
import type { AndroidSubscriptionUsageSnapshot } from "../../../widgets/androidSubscriptionUsageSnapshot";
import { useAppearancePreferences } from "../appearance/AppearancePreferencesProvider";

export function UsageWidgetPreview(props: {
  readonly snapshot: AndroidSubscriptionUsageSnapshot;
  readonly target: string;
}) {
  const { configuration, groups, checkedAt, emptyMessage } = props.snapshot;
  const { height } = useWindowDimensions();
  const systemScheme = useColorScheme() === "dark" ? "dark" : "light";
  const scheme = configuration.theme === "system" ? systemScheme : configuration.theme;
  const { systemColorPalettes, themeVariablesByAppearance } = useAppearancePreferences();
  const variables = themeVariablesByAppearance[scheme];
  const colors = useMemo(
    () =>
      Platform.OS === "android"
        ? { ...getMaterialColors({ scheme }), ...systemColorPalettes?.[scheme] }
        : {
            surface: variables["--color-sheet"],
            onSurface: variables["--color-foreground"],
            onSurfaceVariant: variables["--color-foreground-muted"],
            surfaceVariant: variables["--color-subtle"],
            primary: variables["--color-primary"],
            error: variables["--color-danger"],
          },
    [scheme, variables, systemColorPalettes],
  );
  const compact = configuration.density === "compact";
  const used = configuration.percentage === "used";
  const [expanded, setExpanded] = useState(true);
  const [currentTime, setCurrentTime] = useState(Date.now);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused || !expanded) return;
    const initial = setTimeout(() => setCurrentTime(Date.now()), 0);
    const timer = setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [expanded, focused]);

  return (
    <View className="w-full self-center px-5 pb-3 pt-2" style={{ maxWidth: 720 }}>
      <View className="flex-row items-center justify-between gap-3">
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground-muted">
          {`Preview · ${props.target}`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide preview" : "Show preview"}
          accessibilityState={{ expanded }}
          onPress={() => {
            setCurrentTime(Date.now());
            setExpanded((value) => !value);
          }}
          className="min-h-11 justify-center rounded-full px-3"
        >
          <Text className="text-sm font-t3-medium text-primary-text">
            {expanded ? "Hide" : "Show"}
          </Text>
        </Pressable>
      </View>
      {expanded ? (
        <View
          className="overflow-hidden rounded-[24px]"
          style={{ height: Math.min(200, height * 0.23), backgroundColor: colors.surface }}
        >
          <ScrollView
            key={props.target}
            accessibilityLabel="Widget preview"
            nestedScrollEnabled
            contentContainerStyle={{ padding: compact ? 12 : 16, gap: compact ? 6 : 10 }}
          >
            {groups.length === 0 ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>{emptyMessage}</Text>
            ) : (
              groups.map((group) => (
                <View key={group.id}>
                  <Text
                    numberOfLines={2}
                    className="font-t3-medium"
                    style={{ color: colors.onSurface, fontSize: compact ? 12 : 14 }}
                  >
                    {group.name}
                  </Text>
                  {group.detail ? (
                    <Text
                      numberOfLines={2}
                      style={{ color: colors.onSurfaceVariant, fontSize: 10 }}
                    >
                      {group.detail}
                    </Text>
                  ) : null}
                  {group.windows.map((window) => {
                    const stale = window.expiresAt <= 0 || currentTime >= window.expiresAt;
                    const percent = used ? 100 - window.remaining : window.remaining;
                    const low = window.remaining <= 10;
                    const minutes = Math.max(
                      1,
                      Math.ceil(((window.resetsAt ?? currentTime) - currentTime) / 60_000),
                    );
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
                      <View key={window.id} style={{ paddingTop: compact ? 2 : 5 }}>
                        <Text
                          numberOfLines={2}
                          style={{
                            color: !stale && low ? colors.error : colors.onSurface,
                            fontSize: compact ? 10 : 12,
                          }}
                        >
                          {stale
                            ? `${window.label} · Open T3 to refresh`
                            : `${window.label} · ${percent}% ${used ? "used" : "left"}`}
                        </Text>
                        {!stale && configuration.showBars ? (
                          <View
                            className="overflow-hidden rounded-full"
                            style={{
                              height: compact ? 4 : 6,
                              marginVertical: 3,
                              backgroundColor: colors.surfaceVariant,
                            }}
                          >
                            <View
                              style={{
                                height: "100%",
                                width: `${percent}%`,
                                backgroundColor: low ? colors.error : colors.primary,
                              }}
                            />
                          </View>
                        ) : null}
                        {!stale && configuration.showResetTimes ? (
                          <Text
                            numberOfLines={2}
                            style={{ color: colors.onSurfaceVariant, fontSize: 10 }}
                          >
                            {reset}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ))
            )}
            {configuration.showUpdatedAt && checkedAt > 0 ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 10 }}>
                {`As of ${new Date(checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`}
              </Text>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
