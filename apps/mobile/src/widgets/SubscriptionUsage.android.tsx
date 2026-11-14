import {
  Box,
  Button,
  Column,
  getMaterialColors,
  Image,
  Row,
  Spacer,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  background,
  cornerRadius,
  fillMaxSize,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
  size,
  width,
} from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type {
  SubscriptionUsageSnapshot as SubscriptionUsageProps,
  WidgetLimitAccount,
} from "./subscriptionUsageSnapshot";

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
  const material = getMaterialColors({ scheme: appearance });
  const colors = palette
    ? {
        surface: palette.background,
        onSurface: palette.foreground,
        muted: palette.secondary,
        track: palette.track,
        error: palette.danger,
      }
    : {
        surface: material.surface,
        onSurface: material.onSurface,
        muted: material.onSurfaceVariant,
        track: material.surfaceVariant,
        error: material.error,
      };
  const providers = props.providers ?? [
    { name: "Codex", detail: "Open T3 to connect", windows: [], expiresAt: 0, totalWindows: 0 },
    { name: "Claude", detail: "Open T3 to connect", windows: [], expiresAt: 0, totalWindows: 0 },
  ];

  const pad = 14;
  const labelWidth = 92;
  const footer = 16;
  const widgetWidth = environment.width ?? 320;
  const contentWidth = widgetWidth - pad * 2;
  const contentHeight = (environment.height ?? 200) - pad * 2 - footer;
  const kindOrder: Record<string, number> = { session: 0, weekly: 1 };

  type Line =
    | {
        type: "window";
        provider: string;
        color: string;
        window: SubscriptionUsageProps["providers"][number]["windows"][number];
      }
    | { type: "note"; provider: string; text: string };
  const lines: Line[] = providers.flatMap((provider): Line[] => {
    const stale =
      provider.windows.length > 0 && provider.expiresAt > 0 && now >= provider.expiresAt;
    if (stale || provider.windows.length === 0)
      return [
        {
          type: "note",
          provider: provider.name,
          text: stale ? "Open T3 to refresh" : provider.detail,
        },
      ];
    return [...provider.windows]
      .sort((a, b) => (kindOrder[a.kind ?? ""] ?? 2) - (kindOrder[b.kind ?? ""] ?? 2))
      .map((window) => ({
        type: "window",
        provider: provider.name,
        color: provider.colors?.[appearance] ?? colors.onSurface,
        window,
      }));
  });

  // Roomy rows when every limit fits, thin bars when they would not.
  const fullRow = 34;
  const compactRow = 20;
  const full = lines.length * fullRow <= contentHeight;
  // Glance columns hold at most ten children, the overflow note included.
  const capacity = Math.max(
    1,
    Math.min(9, Math.floor(contentHeight / (full ? fullRow : compactRow))),
  );
  // Rows share any spare height so short lists do not bunch at the top.
  const rowHeight = Math.min(full ? 52 : 28, contentHeight / Math.min(lines.length, capacity));
  const shown = lines.length > capacity ? lines.slice(0, capacity - 1) : lines;
  const hidden = lines.length - shown.length;

  const low = (remaining: number) => remaining <= 10;
  const timeLeft = (account: WidgetLimitAccount) =>
    account.resetsAt && account.durationMs
      ? Math.max(0, Math.min(1, (account.resetsAt - now) / account.durationMs))
      : null;
  const paceArrow = (accounts: WidgetLimitAccount[]) => {
    const timed = accounts.flatMap((account) => {
      const left = timeLeft(account);
      return left === null || account.remaining === undefined
        ? []
        : [{ used: 100 - account.remaining, elapsed: 1 - left }];
    });
    if (timed.length === 0) return "";
    const gap = timed.reduce((sum, t) => sum + t.used - t.elapsed * 100, 0) / timed.length;
    return gap > 5 ? " ↗" : gap < -5 ? " ↘" : " →";
  };

  const segment = (
    account: WidgetLimitAccount,
    color: string,
    segmentWidth: number,
    barHeight: number,
    labels: { name: boolean; percent: boolean; reset: boolean },
  ) => {
    if (account.remaining === undefined)
      return <Spacer key={account.name} modifiers={[size(segmentWidth, barHeight)]} />;
    const fill = (segmentWidth * account.remaining) / 100;
    const refill = (segmentWidth * Math.min(100 - account.remaining, account.refill ?? 0)) / 100;
    const left = timeLeft(account);
    const tick =
      left === null ? null : Math.max(0, Math.min(segmentWidth - 5, segmentWidth * left - 2.5));
    return (
      <Box
        key={account.name}
        modifiers={[size(segmentWidth, barHeight), background(colors.track), cornerRadius(6)]}
      >
        {fill > 0 ? (
          <Box modifiers={[size(fill, barHeight), background(`${color}59`), cornerRadius(6)]} />
        ) : null}
        {refill > 0 ? (
          <Row modifiers={[size(segmentWidth, barHeight)]}>
            <Spacer modifiers={[width(segmentWidth - refill)]} />
            <Image
              source={{ uri: "t3_widget_hatch" }}
              tint={color}
              alpha={0.22}
              contentScale="fillBounds"
              modifiers={[size(refill, barHeight)]}
            />
          </Row>
        ) : null}
        {tick === null ? null : (
          <Row modifiers={[size(segmentWidth, barHeight)]}>
            <Spacer modifiers={[width(tick)]} />
            <Box
              contentAlignment="center"
              modifiers={[size(5, barHeight), background(colors.surface)]}
            >
              <Box
                modifiers={[
                  size(2, Math.max(2, barHeight - 4)),
                  background(colors.onSurface),
                  cornerRadius(1),
                ]}
              />
            </Box>
          </Row>
        )}
        {labels.percent ? (
          <Row
            verticalAlignment="center"
            modifiers={[size(segmentWidth, barHeight), padding(6, 0, 6, 0)]}
          >
            {labels.name ? (
              <Text color={colors.onSurface} maxLines={1} style={{ fontSize: 10 }}>
                {`${account.name} `}
              </Text>
            ) : null}
            <Text
              color={low(account.remaining) ? colors.error : colors.onSurface}
              maxLines={1}
              style={{ fontSize: 10, fontWeight: "bold" }}
            >
              {`${account.remaining}%`}
            </Text>
          </Row>
        ) : null}
        {labels.reset && account.reset ? (
          <Box
            contentAlignment="centerEnd"
            modifiers={[size(segmentWidth, barHeight), padding(0, 0, 3, 0)]}
          >
            <Box modifiers={[background(colors.surface), cornerRadius(4), padding(4, 1, 4, 1)]}>
              <Text color={colors.onSurface} maxLines={1} style={{ fontSize: 9 }}>
                {`↻ ${account.reset}`}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  };

  const bar = (line: Extract<Line, { type: "window" }>, barWidth: number, barHeight: number) => {
    const fallback: WidgetLimitAccount = { name: line.provider, remaining: line.window.remaining };
    const listed = line.window.accounts ?? [];
    // Glance rows hold at most ten children: five segments and their gaps.
    const accounts = listed.length > 0 && listed.length <= 5 ? listed : [fallback];
    const gap = 3;
    const segmentWidth = (barWidth - gap * (accounts.length - 1)) / accounts.length;
    const multi = accounts.length > 1;
    return (
      <Row modifiers={[size(barWidth, barHeight)]}>
        {accounts.flatMap((account, index) => [
          index > 0 ? <Spacer key={`gap-${account.name}`} modifiers={[width(gap)]} /> : null,
          segment(account, account.color ?? line.color, segmentWidth, barHeight, {
            percent: barHeight >= 16 && multi && segmentWidth >= 34,
            name: multi && segmentWidth >= 76,
            reset: barHeight >= 16 && !multi && segmentWidth >= 120,
          }),
        ])}
      </Row>
    );
  };

  const percentText = (remaining: number, fontSize: number) => (
    <Text
      color={low(remaining) ? colors.error : colors.onSurface}
      maxLines={1}
      style={{ fontSize, fontWeight: "bold" }}
    >
      {`${remaining}%`}
    </Text>
  );

  const row = (line: Line) => {
    const label = `${line.provider} ${line.type === "window" ? line.window.label : ""}`.trim();
    if (line.type === "note")
      return (
        <Row
          key={`${line.provider}-note`}
          verticalAlignment="center"
          modifiers={[fillMaxWidth(), height(rowHeight)]}
        >
          <Text color={colors.onSurface} maxLines={1} style={{ fontSize: 11 }}>
            {`${line.provider}  `}
          </Text>
          <Text color={colors.muted} maxLines={1} style={{ fontSize: 11 }}>
            {line.text}
          </Text>
        </Row>
      );
    if (!full)
      return (
        <Row key={label} verticalAlignment="center" modifiers={[fillMaxWidth(), height(rowHeight)]}>
          <Text
            color={colors.muted}
            maxLines={1}
            style={{ fontSize: 10 }}
            modifiers={[width(labelWidth)]}
          >
            {label}
          </Text>
          {bar(line, contentWidth - labelWidth - 40, 6)}
          <Box contentAlignment="centerEnd" modifiers={[width(40)]}>
            {percentText(line.window.remaining, 10)}
          </Box>
        </Row>
      );
    return (
      <Row key={label} verticalAlignment="center" modifiers={[fillMaxWidth(), height(rowHeight)]}>
        <Column modifiers={[width(labelWidth)]}>
          <Text color={colors.muted} maxLines={1} style={{ fontSize: 10 }}>
            {label}
          </Text>
          <Row verticalAlignment="bottom">
            {percentText(line.window.remaining, 18)}
            <Text
              color={colors.muted}
              maxLines={1}
              style={{ fontSize: 10 }}
              modifiers={[padding(3, 0, 0, 3)]}
            >
              {`left${paceArrow(line.window.accounts ?? [])}`}
            </Text>
          </Row>
        </Column>
        <Spacer modifiers={[width(8)]} />
        {bar(line, contentWidth - labelWidth - 8, 20)}
      </Row>
    );
  };

  return (
    // Android lacks widgetURL; one card Button routes taps to the app listener opening props.url.
    <Button
      colors={{ containerColor: colors.surface }}
      modifiers={[fillMaxSize()]}
      onClick={() => {}}
    >
      <Column modifiers={[fillMaxSize(), paddingAll(pad)]}>
        <Column modifiers={[fillMaxWidth(), height(contentHeight)]}>
          {shown.map(row)}
          {hidden > 0 ? (
            <Text color={colors.muted} maxLines={1} style={{ fontSize: 10 }}>
              {`${hidden} more in T3`}
            </Text>
          ) : null}
        </Column>
        <Text
          color={colors.muted}
          maxLines={1}
          style={{ fontSize: 10 }}
          modifiers={[height(footer)]}
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
