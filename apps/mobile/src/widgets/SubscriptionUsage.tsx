import { HStack, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
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
  const limit = family === "systemExtraLarge" ? 6 : family === "systemLarge" ? 4 : 2;
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced;
  const providers = props.providers ?? [
    { name: "Codex", detail: "Open T3 to connect", windows: [], expiresAt: 0 },
    { name: "Claude", detail: "Open T3 to connect", windows: [], expiresAt: 0 },
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
      ? "Open T3 to refresh"
      : period !== "auto" && windows.length === 0 && provider.windows.length > 0
        ? `No ${period} limit reported`
        : provider.detail;
    const barModifiers = [
      progressViewStyle("linear"),
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
                ? `${provider.name}, ${tightest.label}, ${tightest.remaining} percent remaining. ${tightest.reset}. ${provider.detail}.`
                : `${provider.name}. ${detail}.`,
            ),
          ]}
        >
          <HStack spacing={4}>
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "semibold" }),
                lineLimit(1),
                minimumScaleFactor(0.75),
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
                ? `${tightest.remaining}% left`
                : period !== "auto" && !stale && provider.windows.length > 0
                  ? "N/A"
                  : "Open T3"}
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
        spacing={compact ? 2 : 4}
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        <Text
          modifiers={[
            font({ textStyle: compact ? "caption" : "headline", weight: "bold" }),
            lineLimit(1),
            minimumScaleFactor(0.75),
            foregroundStyle("primary"),
          ]}
        >
          {provider.name}
        </Text>
        {(!compact || shown.length === 0) && detail !== "Subscription remaining" ? (
          <Text
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(compact ? 1 : 2),
            ]}
          >
            {detail}
          </Text>
        ) : null}
        {shown.map((window) => (
          <VStack
            key={window.label}
            alignment="leading"
            spacing={2}
            modifiers={[
              accessibilityElement("ignore"),
              accessibilityLabel(
                `${provider.name}, ${window.label}, ${window.remaining} percent remaining. ${window.reset}. ${provider.detail}.`,
              ),
            ]}
          >
            <HStack spacing={4}>
              <Text
                modifiers={[
                  font({ textStyle: compact ? "caption2" : "caption" }),
                  foregroundStyle("secondary"),
                  lineLimit(1),
                  minimumScaleFactor(0.75),
                ]}
              >
                {window.label}
              </Text>
              <Spacer />
              <Text
                modifiers={[
                  font({ textStyle: compact ? "caption2" : "caption", weight: "semibold" }),
                  lineLimit(1),
                  minimumScaleFactor(0.75),
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
                {window.remaining}% left
              </Text>
            </HStack>
            <ProgressView value={window.remaining / 100} modifiers={barModifiers} />
            {!compact ? (
              <Text
                modifiers={[
                  font({ textStyle: "caption2" }),
                  foregroundStyle("secondary"),
                  lineLimit(1),
                  minimumScaleFactor(0.75),
                ]}
              >
                {window.reset}
              </Text>
            ) : null}
          </VStack>
        ))}
        {!compact &&
        !stale &&
        (period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) > limit ? (
          <Text modifiers={[font({ textStyle: "caption2" }), foregroundStyle("secondary")]}>
            {(period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) -
              limit}{" "}
            more in T3
          </Text>
        ) : null}
      </VStack>
    );
  });
  return (
    <VStack
      alignment="leading"
      spacing={accessory ? 2 : 6}
      modifiers={props.url ? [widgetURL(props.url)] : []}
    >
      {compact ? (
        <VStack alignment="leading" spacing={accessory ? 4 : 8}>
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
          modifiers={[
            font({ textStyle: "caption2" }),
            foregroundStyle("secondary"),
            lineLimit(1),
            minimumScaleFactor(0.75),
          ]}
        >
          {props.checkedAt
            ? `As of ${new Date(props.checkedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`
            : "Tap to connect in T3"}
        </Text>
      ) : null}
    </VStack>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
