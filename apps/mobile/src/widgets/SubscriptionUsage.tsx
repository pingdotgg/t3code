import { getLocalizedDateTimeFormatter, translate } from "@t3tools/i18n";
import { HStack, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  progressViewStyle,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { SubscriptionUsageSnapshot as SubscriptionUsageProps } from "./subscriptionUsageSnapshot";

type UsageConfiguration = {
  codexPeriod?: "auto" | "session" | "weekly";
  claudePeriod?: "auto" | "session" | "weekly";
};

function SubscriptionUsage(
  props: SubscriptionUsageProps,
  environment: WidgetEnvironment<UsageConfiguration>,
) {
  "widget";
  // The extension evaluates this function without the app's module scope.
  const family = environment.widgetFamily;
  // Gallery snapshots can render an old timeline entry after it has expired.
  const now = Math.max(environment.date.getTime(), Date.now());
  const accessory = family === "accessoryRectangular";
  const compact =
    family === "systemSmall" || accessory || environment.levelOfDetail === "simplified";
  // Budget short cards for two quotas per provider, including their secondary text.
  const dense = family === "systemSmall" || family === "systemMedium";
  const limit = family === "systemExtraLarge" ? 6 : family === "systemLarge" ? 4 : 2;
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced;
  const providers = props.providers ?? [
    {
      name: "Codex",
      detail: translate("common:mobileWidgets.openToConnect", "Open T3 to connect"),
      windows: [],
      expiresAt: 0,
    },
    {
      name: "Claude",
      detail: translate("common:mobileWidgets.openToConnect", "Open T3 to connect"),
      windows: [],
      expiresAt: 0,
    },
  ];
  const columns = providers.map((provider) => {
    const stale = provider.windows.length > 0 && now >= provider.expiresAt;
    const period =
      environment.configuration?.[provider.name === "Claude" ? "claudePeriod" : "codexPeriod"] ??
      "auto";
    const windows = stale
      ? []
      : provider.windows.filter((window) => period === "auto" || window.kind === period);
    // Lock Screen widgets surface the tightest selected limit.
    const tightest = windows.reduce<(typeof windows)[number] | undefined>(
      (result, window) => (!result || window.remaining < result.remaining ? window : result),
      undefined,
    );
    const compactWindows = [
      windows.find((window) => window.kind === "session"),
      windows.find((window) => window.kind === "weekly"),
    ].filter((window) => window !== undefined);
    const shown =
      accessory || environment.levelOfDetail === "simplified"
        ? tightest
          ? [tightest]
          : []
        : family === "systemSmall" && compactWindows.length > 0
          ? compactWindows
          : period === "auto" && compactWindows.length > 0
            ? [
                ...compactWindows,
                ...windows.filter((window) => !compactWindows.includes(window)),
              ].slice(0, limit)
            : windows.slice(0, limit);
    const detail = stale
      ? translate("common:mobileWidgets.openToRefresh", "Open T3 to refresh")
      : period !== "auto" && windows.length === 0 && provider.windows.length > 0
        ? translate("common:mobileWidgets.noPeriodLimit", "No {{period}} limit reported", {
            period: translate(
              period === "session" ? "common:mobileUsage.session" : "common:mobileUsage.weekly",
              period,
            ),
          })
        : provider.detail;
    const barModifiers = [
      progressViewStyle("linear"),
      frame({ height: 4 }),
      ...(monochrome ? [] : [tint(provider.name === "Claude" ? "#d97757" : "#8e8e93")]),
    ];
    if (accessory) {
      return (
        <VStack
          key={provider.name}
          alignment="leading"
          spacing={2}
          modifiers={[
            accessibilityElement("ignore"),
            accessibilityLabel(
              tightest
                ? translate(
                    "common:mobileWidgets.remainingAccessibility",
                    "{{provider}}, {{window}}, {{percent}} percent remaining. {{reset}}. {{detail}}.",
                    {
                      provider: provider.name,
                      window: tightest.label,
                      percent: tightest.remaining,
                      reset: tightest.reset,
                      detail: provider.detail,
                    },
                  )
                : `${provider.name}. ${detail}.`,
            ),
          ]}
        >
          <HStack spacing={4}>
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                foregroundStyle("primary"),
              ]}
            >
              {provider.name}
              {tightest ? ` · ${tightest.label}` : ""}
            </Text>
            <Spacer />
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                layoutPriority(1),
                foregroundStyle("primary"),
              ]}
            >
              {tightest
                ? translate("common:mobileWidgets.percentLeft", "{{percent}}% left", {
                    percent: tightest.remaining,
                  })
                : period !== "auto" && !stale && provider.windows.length > 0
                  ? "N/A"
                  : translate("common:mobileWidgets.openT3", "Open T3")}
            </Text>
          </HStack>
          {tightest ? (
            <ProgressView value={tightest.remaining / 100} modifiers={barModifiers} />
          ) : null}
        </VStack>
      );
    }
    return (
      <VStack
        key={provider.name}
        alignment="leading"
        spacing={dense ? 1 : compact ? 2 : 4}
        modifiers={[
          frame({ maxWidth: Infinity, alignment: "leading" }),
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        <Text
          modifiers={[
            font({ textStyle: compact ? "caption" : "headline", weight: "bold" }),
            lineLimit(1),
            foregroundStyle("primary"),
          ]}
        >
          {provider.name}
        </Text>
        {!compact || shown.length === 0 ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          >
            {detail === "Subscription remaining" ? " " : detail}
          </Text>
        ) : null}
        {shown.map((window) => (
          <VStack
            key={window.label}
            alignment="leading"
            spacing={dense ? 1 : 2}
            modifiers={[
              accessibilityElement("ignore"),
              accessibilityLabel(
                translate(
                  "common:mobileWidgets.remainingAccessibility",
                  "{{provider}}, {{window}}, {{percent}} percent remaining. {{reset}}. {{detail}}.",
                  {
                    provider: provider.name,
                    window: window.label,
                    percent: window.remaining,
                    reset: window.reset,
                    detail: provider.detail,
                  },
                ),
              ),
            ]}
          >
            <HStack spacing={4}>
              <Text
                modifiers={[
                  font({ textStyle: compact || dense ? "caption2" : "caption" }),
                  foregroundStyle("secondary"),
                  lineLimit(1),
                ]}
              >
                {window.label}
              </Text>
              <Spacer />
              <Text
                modifiers={[
                  font({
                    textStyle: compact || dense ? "caption2" : "caption",
                    weight: "semibold",
                  }),
                  lineLimit(1),
                  layoutPriority(1),
                  foregroundStyle(
                    window.remaining <= 10 && !monochrome
                      ? environment.colorScheme === "light"
                        ? "#dc2626"
                        : "#fca5a5"
                      : "primary",
                  ),
                ]}
              >
                {translate("common:mobileWidgets.percentLeft", "{{percent}}% left", {
                  percent: window.remaining,
                })}
              </Text>
            </HStack>
            <ProgressView value={window.remaining / 100} modifiers={barModifiers} />
            {!compact ? (
              <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
                {window.reset}
              </Text>
            ) : null}
          </VStack>
        ))}
        {!compact &&
        !stale &&
        (period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) > limit ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          >
            {translate("common:mobileWidgets.moreInT3", "{{count}} more in T3", {
              count:
                (period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) -
                limit,
            })}
          </Text>
        ) : null}
      </VStack>
    );
  });
  return (
    <VStack
      alignment="leading"
      spacing={accessory || dense ? 2 : 6}
      modifiers={props.url ? [widgetURL(props.url)] : []}
    >
      {providers.length === 0 ? (
        <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle("secondary")]}>
          {translate(
            "common:mobileWidgets.noSubscriptionLimits",
            "No subscription limits available.",
          )}
        </Text>
      ) : compact ? (
        <VStack alignment="leading" spacing={accessory || dense ? 4 : 8}>
          {columns}
        </VStack>
      ) : (
        <HStack alignment="top" spacing={16}>
          {columns}
        </HStack>
      )}
      {!accessory ? <Spacer /> : null}
      {!accessory ? (
        <Text
          modifiers={[font({ textStyle: "caption2" }), foregroundStyle("secondary"), lineLimit(1)]}
        >
          {props.checkedAt
            ? translate("common:mobileWidgets.asOf", "As of {{date}}", {
                date: getLocalizedDateTimeFormatter({
                  hour: "numeric",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                }).format(new Date(props.checkedAt)),
              })
            : translate("common:mobileWidgets.tapToConnect", "Tap to connect in T3")}
        </Text>
      ) : null}
    </VStack>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
