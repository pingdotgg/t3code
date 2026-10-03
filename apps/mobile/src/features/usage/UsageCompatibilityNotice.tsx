import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

import { EmptyState } from "../../components/EmptyState";
import type { usageAvailability } from "./usageAvailability";

export function UsageCompatibilityNotice({
  availability,
  onRetry,
  refreshing = false,
}: {
  readonly availability: ReturnType<typeof usageAvailability>;
  readonly onRetry?: () => void;
  readonly refreshing?: boolean;
}) {
  if (availability.notices.length === 0) return null;
  const detail = [
    ...availability.notices.map(({ message }) => message),
    availability.coverageMessage,
  ].join("\n\n");
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite">
      <EmptyState
        title={availability.hasCompatibleSummary ? "Usage may be incomplete" : "Usage unavailable"}
        detail={detail}
        action={
          availability.canRetry && onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={refreshing ? "Retrying usage" : "Retry usage"}
              disabled={refreshing}
              onPress={onRetry}
              className="rounded-full border border-border bg-card px-4 py-2.5 disabled:opacity-50"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                {refreshing ? "Retrying…" : "Retry"}
              </Text>
            </Pressable>
          ) : undefined
        }
      />
    </View>
  );
}
