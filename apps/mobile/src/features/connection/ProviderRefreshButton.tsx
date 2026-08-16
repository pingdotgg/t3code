import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

export function ProviderRefreshButton(props: {
  readonly onRefresh: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly compact?: boolean;
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const iconColor = useThemeColor("--color-icon-muted");
  const primaryColor = useThemeColor("--color-primary");

  const handlePress = useCallback(async () => {
    if (isRefreshing) return;

    setIsRefreshing(true);
    const result = await props.onRefresh();
    setIsRefreshing(false);

    if (AsyncResult.isFailure(result)) {
      if (isAtomCommandInterrupted(result)) return;
      const error = Cause.squash(result.cause);
      Alert.alert(
        "Could not refresh providers",
        error instanceof Error ? error.message : "The provider status could not be refreshed.",
      );
      return;
    }

    Alert.alert("Providers refreshed", "Provider availability and model metadata are up to date.");
  }, [isRefreshing, props.onRefresh]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh providers"
      accessibilityState={{ busy: isRefreshing, disabled: isRefreshing }}
      disabled={isRefreshing}
      testID="refresh-providers-button"
      onPress={() => void handlePress()}
      className={cn(
        "items-center justify-center rounded-[14px] border border-input-border bg-input active:opacity-70 disabled:opacity-50",
        props.compact ? "h-[42px] w-[42px]" : "min-h-[42px] flex-row gap-1.5 px-3.5 py-2.5",
      )}
    >
      {isRefreshing ? (
        <ActivityIndicator color={primaryColor} size="small" />
      ) : (
        <SymbolView name="arrow.clockwise" size={14} tintColor={iconColor} type="monochrome" />
      )}
      {props.compact ? null : (
        <Text className="text-xs font-t3-bold tracking-[0.8px] uppercase text-foreground">
          Refresh providers
        </Text>
      )}
    </Pressable>
  );
}
