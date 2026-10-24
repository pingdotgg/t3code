import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
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
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite">
      <EmptyState
        title={
          availability.hasCompatibleSummary
            ? "Usage may be incomplete"
            : availability.isLoading
              ? "Loading usage"
              : "Usage unavailable"
        }
        detail={detail}
        action={
          availability.canRetry && onRetry ? (
            <Button
              label={refreshing ? "Retrying…" : "Retry"}
              accessibilityHint="Refresh usage from the selected environments."
              loading={refreshing}
              onPress={onRetry}
            />
          ) : undefined
        }
      />
    </View>
  );
}
