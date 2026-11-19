import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import {
  ROW_TONE_TEXT,
  ROW_TONE_TINT,
  orbitAgentProvider,
  type DotTone,
  type RowStatus,
} from "./taskPresentation";

/** Every Tasks list row: inset 8pt from the edge, 12pt corners, highlighted only while pressed. */
export function TaskListRow(props: {
  readonly lead: ReactNode;
  readonly title: ReactNode;
  /** Work in progress drops to regular weight, like a working thread. */
  readonly recede?: boolean;
  readonly muted?: boolean;
  readonly trailing?: ReactNode;
  readonly detail?: ReactNode;
  readonly detailTrailing?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      accessibilityLabel={props.accessibilityLabel}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="mx-2"
    >
      {({ pressed }) => (
        <View className={cn("rounded-xl px-2 py-2.5", pressed && "bg-row-hover")}>
          <View className="flex-row items-start gap-2">
            <View className="h-[23px] w-5 items-start justify-center">{props.lead}</View>
            <Text
              className={cn(
                "min-w-0 flex-1 text-base",
                props.muted ? "text-foreground-muted" : "text-foreground",
                !props.recede && !props.muted && "font-t3-medium",
              )}
              numberOfLines={2}
            >
              {props.title}
            </Text>
            {props.trailing ? (
              <View className="h-[23px] justify-center">{props.trailing}</View>
            ) : null}
          </View>
          {props.detail || props.detailTrailing ? (
            <View className="mt-1 flex-row items-center gap-2 pl-7">
              <Text
                className="min-w-0 flex-1 text-[13px] leading-5 text-foreground-tertiary"
                numberOfLines={1}
              >
                {props.detail}
              </Text>
              {props.detailTrailing}
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

/** A row's coloured status: icon, then a label or a timer, medium weight like the label beside it. */
export function RowStatusView(props: { readonly status: RowStatus }) {
  const m = useMessages();
  const { status } = props;
  const text = [
    status.label === null ? null : m(status.label),
    status.timerMs === null ? null : formatWorkingDurationLabel(status.timerMs, m),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <View className="flex-row items-center gap-1">
      <SymbolView
        name={status.icon}
        size={13}
        type="monochrome"
        weight="semibold"
        tintColorClassName={ROW_TONE_TINT[status.tone]}
      />
      {text ? (
        <Text className={cn("text-sm font-t3-medium tabular-nums", ROW_TONE_TEXT[status.tone])}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

export function QuietValue(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text className={cn("text-sm tabular-nums text-foreground-tertiary", props.className)}>
      {props.children}
    </Text>
  );
}

/** Lines added and removed, or a dash when Orbit did not report them. */
export function DiffStat(props: {
  readonly added: number | null;
  readonly deleted: number | null;
  readonly className?: string;
}) {
  if (props.added === null || props.deleted === null)
    return <QuietValue className={cn("opacity-60", props.className)}>–</QuietValue>;
  return (
    <View className="flex-row items-center gap-1">
      <Text className={cn("text-sm tabular-nums text-adaptive-emerald-600-400", props.className)}>
        +{props.added.toLocaleString()}
      </Text>
      <Text className={cn("text-sm tabular-nums text-danger-foreground", props.className)}>
        −{props.deleted.toLocaleString()}
      </Text>
    </View>
  );
}

const PROJECT_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#ef4444",
];

/** Orbit projects carry no favicon, so a task row shows a lettered tile in a stable colour. */
export function ProjectTile(props: { readonly name: string }) {
  const hash = [...props.name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-5 w-5 items-center justify-center rounded-md"
      style={{ backgroundColor: PROJECT_COLORS[hash % PROJECT_COLORS.length] }}
    >
      <Text className="text-3xs font-t3-bold text-white">
        {(props.name[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

const DOT_CLASS: Readonly<Record<DotTone, string>> = {
  success: "bg-adaptive-emerald-600-400",
  info: "bg-adaptive-sky-600-400",
  warning: "bg-warning-foreground",
  destructive: "bg-adaptive-rose-600-400",
  muted: "bg-foreground-muted",
};

/** An agent's model icon with a status dot at its corner. */
export function AgentGlyph(props: {
  readonly provider: string | null;
  readonly dot: DotTone;
  readonly size?: number;
}) {
  const size = props.size ?? 16;
  return (
    <View style={{ width: size, height: size }}>
      <ProviderIcon provider={orbitAgentProvider(props.provider)} size={size} />
      <View
        className={cn(
          "absolute h-2 w-2 rounded-full border-[1.5px] border-screen",
          DOT_CLASS[props.dot],
        )}
        style={{ right: -3, bottom: -3 }}
      />
    </View>
  );
}

export function StateGlyph(props: {
  readonly name: AppSymbolName;
  readonly tintClassName: string;
  readonly size?: number;
  readonly faded?: boolean;
}) {
  return (
    <View className={props.faded ? "opacity-40" : undefined}>
      <SymbolView
        name={props.name}
        size={props.size ?? 16}
        type="monochrome"
        weight="medium"
        tintColorClassName={props.tintClassName}
      />
    </View>
  );
}

/** A second-level heading on detail screens, smaller than the title. */
export function SectionHeading(props: { readonly title: string; readonly meta?: string }) {
  return (
    <View className="mt-7 mb-5 flex-row items-center gap-2.5 px-4">
      <Text className="flex-1 text-[19px] leading-6 font-t3-medium text-foreground">
        {props.title}
      </Text>
      {props.meta ? <QuietValue>{props.meta}</QuietValue> : null}
    </View>
  );
}

/** A fact about the item: icon, one line, a quiet value. A row that leads somewhere gets a chevron. */
export function InfoRow(props: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly multiline?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      accessibilityLabel={props.accessibilityLabel}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="mx-2"
    >
      {({ pressed }) => (
        <View
          style={{ minHeight: 44 }}
          className={cn(
            "flex-row items-center gap-2 rounded-xl px-2",
            props.multiline && "py-2.5",
            pressed && "bg-row-hover",
          )}
        >
          <View className="w-5 items-start">{props.icon}</View>
          <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
            {typeof props.children === "string" ? (
              <Text
                className="min-w-0 flex-1 text-[15px] text-foreground"
                numberOfLines={props.multiline ? undefined : 1}
              >
                {props.children}
              </Text>
            ) : (
              props.children
            )}
          </View>
          {props.trailing}
          {props.onPress ? (
            <SymbolView
              name="chevron.right"
              size={13}
              type="monochrome"
              weight="semibold"
              tintColorClassName="accent-foreground-tertiary"
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function EmptyLine(props: { readonly children: ReactNode }) {
  return <Text className="px-4 py-3 text-[15px] text-foreground-muted">{props.children}</Text>;
}
