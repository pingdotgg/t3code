import { useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";

import { sharedLocationMapsUrl, type DraftComposerLocationAttachment } from "../lib/sharedLocation";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";

export function LocationAttachmentCard(props: {
  readonly location: DraftComposerLocationAttachment;
  readonly onRemove?: () => void;
  readonly compact?: boolean;
}) {
  const { location, onRemove, compact = false } = props;
  const [openError, setOpenError] = useState(false);

  const openInMaps = async () => {
    setOpenError(false);
    try {
      await Linking.openURL(
        sharedLocationMapsUrl(location, Platform.OS === "ios" ? "ios" : "android"),
      );
    } catch {
      setOpenError(true);
    }
  };

  const coordinates = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;

  if (compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${location.name} in Maps`}
        onPress={() => void openInMaps()}
        className="size-full items-center justify-center rounded-2xl bg-subtle"
      >
        <SymbolView name="mappin" size={20} tintColorClassName="accent-icon" />
      </Pressable>
    );
  }

  return (
    <View
      style={{ width: 270, maxWidth: "100%" }}
      className="overflow-hidden rounded-2xl border border-border bg-card"
    >
      <View className="flex-row items-center gap-2 px-3 pt-3">
        <AppText className="min-w-0 flex-1 font-t3-medium text-sm" numberOfLines={1}>
          {location.name}
        </AppText>
        {onRemove ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove location attachment"
            accessibilityHint="Removes this location from the message"
            onPress={onRemove}
            className="size-9 items-center justify-center rounded-full active:bg-subtle"
            hitSlop={4}
          >
            <SymbolView name="xmark" size={18} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${location.name} in Maps`}
        accessibilityHint="Opens this location in your maps app"
        onPress={() => void openInMaps()}
        className="gap-2.5 px-3 pb-3 pt-2 active:opacity-80"
      >
        <View
          accessible={false}
          className="relative h-[76px] items-center justify-center overflow-hidden rounded-xl bg-subtle"
        >
          <View className="absolute -left-5 top-[22px] h-3 w-[310px] rotate-[-12deg] rounded-full bg-card/85" />
          <View className="absolute -left-8 top-[62px] h-2 w-[310px] rotate-[16deg] rounded-full bg-card/80" />
          <View className="absolute left-[44px] -top-4 h-[140px] w-2 rotate-[21deg] rounded-full bg-card/80" />
          <View className="absolute right-[42px] -top-4 h-[140px] w-2 rotate-[-28deg] rounded-full bg-card/80" />
          <View className="size-9 items-center justify-center rounded-full bg-primary shadow-sm">
            <SymbolView name="mappin" size={20} tintColorClassName="accent-primary-foreground" />
          </View>
        </View>

        {location.address ? (
          <AppText className="text-xs leading-snug text-foreground-secondary" numberOfLines={2}>
            {location.address}
          </AppText>
        ) : null}
        <AppText className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
          {coordinates}
          {location.accuracy === null
            ? " · Accuracy unknown"
            : ` · ±${Math.round(location.accuracy)} m`}
        </AppText>
        <View className="flex-row items-center gap-1.5">
          <SymbolView name="arrow.up.right" size={14} tintColorClassName="accent-icon" />
          <AppText className="font-t3-medium text-xs text-foreground">Open in Maps</AppText>
        </View>
        {openError ? (
          <AppText accessibilityRole="alert" className="text-xs text-danger-foreground">
            Could not open Maps. Try again.
          </AppText>
        ) : null}
      </Pressable>
    </View>
  );
}
