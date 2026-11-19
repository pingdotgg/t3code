import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { cn } from "../../lib/cn";

/** The label column of every key-value row: icon, then the key, 116pt wide. */
const KEY_WIDTH = 116;
export const LINE_TABS_HEIGHT = 48;

export function KvIcon(props: { readonly name: AppSymbolName; readonly tintClassName?: string }) {
  return (
    <SymbolView
      name={props.name}
      size={16}
      type="monochrome"
      weight="medium"
      tintColorClassName={props.tintClassName ?? "accent-foreground-muted"}
    />
  );
}

/**
 * One fact on a task, subtask or pull request: icon and key on the left, the value beside them.
 * A row that leads somewhere gets a chevron; `external` rows open outside the app and get none.
 */
export function KvRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
  readonly onPress?: () => void;
  readonly external?: boolean;
  readonly accessibilityLabel?: string;
}) {
  const row = (pressed: boolean) => (
    <View
      style={{ minHeight: 40 }}
      className={cn("flex-row items-center gap-2 px-4", pressed && "bg-row-hover")}
    >
      <View style={{ width: KEY_WIDTH }} className="flex-row items-center gap-2">
        <View className="w-4 items-center">{props.icon}</View>
        <Text className="text-[15px] text-foreground-muted" numberOfLines={1}>
          {props.label}
        </Text>
      </View>
      <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
        {typeof props.children === "string" ? <KvText>{props.children}</KvText> : props.children}
      </View>
      {props.onPress && !props.external ? (
        <SymbolView
          name="chevron.right"
          size={13}
          type="monochrome"
          weight="semibold"
          tintColorClassName="accent-foreground-tertiary"
        />
      ) : null}
    </View>
  );
  // A row that leads nowhere stays a plain view, so controls in its value stay reachable.
  if (!props.onPress) return row(false);
  return (
    <Pressable
      accessibilityRole={props.external ? "link" : "button"}
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
    >
      {({ pressed }) => row(pressed)}
    </Pressable>
  );
}

export function KvText(props: {
  readonly children: ReactNode;
  readonly className?: string;
  /** Long values such as branch names wrap instead of hiding their end. */
  readonly wrap?: boolean;
}) {
  return (
    <Text
      className={cn(
        "min-w-0 shrink text-[15px] text-foreground",
        props.wrap && "py-2 leading-6",
        props.className,
      )}
      numberOfLines={props.wrap ? undefined : 1}
    >
      {props.children}
    </Text>
  );
}

/** Title, the full-width line under it, then the key-value rows: one block on every detail. */
export function DetailHeader(props: {
  readonly title: string;
  readonly notice?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View>
      <Text
        selectable
        className="px-4 pt-6 pb-4 text-[24px] leading-[30px] font-t3-medium text-foreground"
      >
        {props.title}
      </Text>
      <View className="h-px bg-border" />
      {props.notice}
      <View className="py-3">{props.children}</View>
    </View>
  );
}

export interface LineTab<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: string;
  readonly accessibilityLabel?: string;
}

/** Underline tabs: label and count, a 2pt bar under the open one, lines above and below. */
export function LineTabs<T extends string>(props: {
  readonly value: T;
  readonly items: ReadonlyArray<LineTab<T>>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className="border-y border-border bg-screen"
      style={{ height: LINE_TABS_HEIGHT }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "stretch", gap: 20, paddingHorizontal: 16 }}
      >
        {props.items.map((item) => {
          const selected = item.value === props.value;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="tab"
              accessibilityLabel={item.accessibilityLabel}
              accessibilityState={{ selected }}
              onPress={() => props.onChange(item.value)}
              className={cn(
                "-mb-px flex-row items-center gap-1.5 border-b-2",
                selected ? "border-foreground" : "border-transparent",
              )}
            >
              <Text
                className={cn(
                  "text-[15px] font-t3-medium",
                  selected ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {item.label}
              </Text>
              {item.count ? (
                <Text className="text-[15px] tabular-nums text-foreground-muted">{item.count}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A tab's own summary and actions, on the first row of its content: the tab row has no room. */
export function TabActions(props: { readonly children: ReactNode }) {
  return (
    <View className="min-h-12 flex-row items-center justify-between gap-2 px-4 pt-2">
      {props.children}
    </View>
  );
}

/** A fully rounded pill button for tab actions, such as the timeline order. */
export function TabPill(props: {
  readonly icon?: AppSymbolName;
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className="h-8 flex-row items-center gap-1.5 rounded-full border border-border bg-grouped-card px-3 active:opacity-70"
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={14}
          type="monochrome"
          tintColorClassName="accent-foreground"
        />
      ) : null}
      <Text className="text-[14px] text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/**
 * Keeps a detail screen's tabs under the bar once the key-value rows scroll away. The tabs scroll
 * with the content until they reach the bar; from there a copy holds them, and the bar area turns
 * solid so nothing shows between the bar and the tabs.
 */
export function useDockedTabs(overlap?: number) {
  const bar = useBarOverlap();
  const barOverlap = overlap ?? bar;
  const [tabsY, setTabsY] = useState<number | null>(null);
  const [docked, setDocked] = useState(false);
  return {
    barOverlap,
    /** Where the tabs end up in content coordinates once docked, as a scroll offset. */
    dockOffset: tabsY === null ? null : tabsY - barOverlap,
    /** Put on the view right above the tabs, in a parent laid out from the content's top. */
    onHeaderLayout: (event: LayoutChangeEvent) =>
      setTabsY(event.nativeEvent.layout.y + event.nativeEvent.layout.height),
    onScrollOffset: (offset: number) => {
      const next = tabsY !== null && offset + barOverlap >= tabsY - 0.5;
      if (next !== docked) setDocked(next);
    },
    docked,
  };
}

export function DockedTabs(props: {
  readonly docked: ReturnType<typeof useDockedTabs>;
  readonly children: ReactNode;
}) {
  if (!props.docked.docked) return null;
  return (
    <View pointerEvents="box-none" className="absolute inset-x-0 top-0">
      <View
        pointerEvents="none"
        className="bg-screen"
        style={{ height: props.docked.barOverlap }}
      />
      {props.children}
    </View>
  );
}
