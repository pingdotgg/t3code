import type {
  ProviderDriverKind,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectVendorQuotas,
  MODEL_VENDOR_IDS,
  modelVendorAccentColor,
  modelVendorDisplayName,
  modelVendorIconDriver,
  type ModelVendorId,
  type VendorQuotaWindowItem,
} from "@t3tools/shared/modelVendorQuota";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import * as Haptics from "expo-haptics";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

function quotaBarColor(usedPercent: number, brandColor: string): string {
  if (usedPercent >= 90) return "#ef4444";
  if (usedPercent >= 80) return "#f59e0b";
  return brandColor;
}

function MobileQuotaWindowRow(props: {
  readonly item: VendorQuotaWindowItem;
  readonly brandColor: string;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const resetsIn = formatResetsIn(props.item.window, props.now, m);
  const fillColor = quotaBarColor(props.item.usedPercent, props.brandColor);

  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {props.item.window.label}
        </Text>
        <Text className="text-xs font-t3-medium text-foreground">
          {gt("{remaining}% left", { remaining: props.item.remainingPercent })}
        </Text>
      </View>
      <View className="h-2 w-full overflow-hidden rounded-full bg-surface-subtle">
        <View
          className="h-full rounded-full"
          style={{
            width: `${props.item.usedPercent}%`,
            backgroundColor: fillColor,
          }}
        />
      </View>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-[11px] text-foreground-muted">
          {gt("{used}% used", { used: props.item.usedPercent })}
        </Text>
        <Text className="text-[11px] text-foreground-muted" numberOfLines={1}>
          {resetsIn ?? props.item.sourceName}
        </Text>
      </View>
    </View>
  );
}

export function ThreadSettingsVendorQuotaHeader(props: {
  readonly vendorFilter: ModelVendorId | null;
  readonly onSelectVendor: (vendor: ModelVendorId | null) => void;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: UsageLimitSourceSnapshots;
}) {
  const gt = useGT();
  const [now] = useState(() => Date.now());
  const vendorQuotas = collectVendorQuotas({
    providers: props.providers,
    sources: props.sources,
    now,
  });

  const selectedSummary = props.vendorFilter ? vendorQuotas[props.vendorFilter] : null;

  return (
    <View className="px-4 pt-2 pb-3 gap-3">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: props.vendorFilter === null }}
          className={cn(
            "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
            props.vendorFilter === null
              ? "border-accent bg-accent/15"
              : "border-border-subtle bg-grouped-card",
          )}
          onPress={() => {
            void Haptics.selectionAsync();
            props.onSelectVendor(null);
          }}
        >
          <Text
            className={cn(
              "text-xs font-t3-medium",
              props.vendorFilter === null ? "text-foreground" : "text-foreground-muted",
            )}
          >
            {gt("All")}
          </Text>
        </Pressable>

        {MODEL_VENDOR_IDS.map((vendor) => {
          const isSelected = props.vendorFilter === vendor;
          const summary = vendorQuotas[vendor];
          const minLeft = summary.minRemainingPercent;
          const label =
            vendor === "gemini" ? gt("Gemini (Antigravity)") : modelVendorDisplayName(vendor);
          return (
            <Pressable
              key={vendor}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              className={cn(
                "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
                isSelected ? "border-accent bg-accent/15" : "border-border-subtle bg-grouped-card",
              )}
              onPress={() => {
                void Haptics.selectionAsync();
                props.onSelectVendor(isSelected ? null : vendor);
              }}
            >
              <ProviderIcon
                provider={modelVendorIconDriver(vendor) as ProviderDriverKind}
                size={14}
              />
              <Text
                className={cn(
                  "text-xs font-t3-medium",
                  isSelected ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {label}
              </Text>
              {minLeft !== null ? (
                <Text className="text-[11px] font-t3-medium text-foreground-muted">{minLeft}%</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      {selectedSummary ? (
        <View className="gap-2.5 rounded-2xl bg-grouped-card p-3.5">
          <View className="flex-row items-center justify-between gap-2">
            <View className="flex-row items-center gap-2">
              <ProviderIcon
                provider={modelVendorIconDriver(selectedSummary.vendor) as ProviderDriverKind}
                size={16}
              />
              <Text className="text-sm font-t3-semibold text-foreground">
                {modelVendorDisplayName(selectedSummary.vendor)}
              </Text>
              {selectedSummary.viaAntigravityOnly && selectedSummary.vendor !== "gemini" ? (
                <View className="rounded-full border border-border-subtle px-2 py-0.5">
                  <Text className="text-[10px] text-foreground-muted">Antigravity</Text>
                </View>
              ) : null}
            </View>
          </View>
          {selectedSummary.windows.length > 0 ? (
            selectedSummary.windows.map((item) => (
              <MobileQuotaWindowRow
                key={item.key}
                item={item}
                brandColor={modelVendorAccentColor(selectedSummary.vendor)}
                now={now}
              />
            ))
          ) : (
            <Text className="text-xs text-foreground-muted">
              {selectedSummary.unavailableMessage ??
                gt("No active quota for {vendor}.", {
                  vendor: modelVendorDisplayName(selectedSummary.vendor),
                })}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
