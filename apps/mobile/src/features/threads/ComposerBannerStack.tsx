import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

/**
 * Where a notice sits in the stack. Environment first, then what needs you; the
 * order is fixed so rows never trade places as notices come and go.
 */
export type ComposerBannerGroup = "environment" | "attention";

export type ComposerBannerVariant = "default" | "warning" | "error";

export type ComposerBannerStackItem = {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly group?: ComposerBannerGroup;
  readonly icon: AppSymbolName;
  readonly title: string;
  readonly description?: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
};

const GROUPS = ["environment", "attention"] as const;

const VARIANT_CLASS = {
  default: "bg-card",
  warning: "bg-warning",
  error: "bg-danger",
} as const;

const TITLE_CLASS = {
  default: "text-foreground",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
} as const;

const MUTED_CLASS = {
  default: "text-foreground-muted",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
} as const;

const ICON_CLASS = {
  default: "accent-icon-muted",
  warning: "accent-warning-foreground",
  error: "accent-danger-foreground",
} as const;

/**
 * Notices about sending from this composer, each its own attached card. Consecutive
 * cards join edge to edge, and the last joins the composer below it. Horizontal inset
 * belongs on the parent so the stack and composer share one column.
 */
export function ComposerBannerStack(props: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
  readonly children?: ReactNode;
}) {
  const ordered = GROUPS.flatMap((group) =>
    props.items.filter((item) => (item.group ?? "attention") === group),
  );
  // Keep a stable wrapper so the composer child is not remounted when the first
  // banner appears or the last is dismissed (native editor undo/revision state).
  return (
    <View>
      {ordered.map((item) => (
        <View
          key={item.id}
          accessibilityRole={
            item.variant === "error" || item.variant === "warning" ? "alert" : undefined
          }
          className={cn("border-b border-border px-3.5 py-3", VARIANT_CLASS[item.variant])}
        >
          <BannerRow item={item} />
        </View>
      ))}
      {props.children}
    </View>
  );
}

function BannerRow(props: { readonly item: ComposerBannerStackItem }) {
  const { item } = props;
  return (
    <View className="flex-row items-start gap-3">
      <View className="pt-0.5">
        <SymbolView name={item.icon} size={16} tintColorClassName={ICON_CLASS[item.variant]} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <AppText
          selectable
          textRole="footnote"
          accessibilityLiveRegion="polite"
          className={cn("font-t3-medium", TITLE_CLASS[item.variant])}
        >
          {item.title}
        </AppText>
        {item.description ? (
          <AppText selectable textRole="footnote" className={MUTED_CLASS[item.variant]}>
            {item.description}
          </AppText>
        ) : null}
        {item.action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.action.label}
            onPress={item.action.onPress}
            hitSlop={8}
            className="self-start py-1 active:opacity-60"
          >
            <AppText
              textRole="footnote"
              className={cn("font-t3-semibold", TITLE_CLASS[item.variant])}
            >
              {item.action.label}
            </AppText>
          </Pressable>
        ) : null}
      </View>
      {item.onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.dismissLabel ?? "Dismiss message"}
          onPress={item.onDismiss}
          hitSlop={10}
          className="min-h-6 min-w-6 items-center justify-center active:opacity-60"
        >
          <SymbolView name="xmark" size={14} tintColorClassName={ICON_CLASS[item.variant]} />
        </Pressable>
      ) : null}
    </View>
  );
}
