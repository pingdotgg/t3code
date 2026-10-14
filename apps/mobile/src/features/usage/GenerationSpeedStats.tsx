import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { UsageSummary } from "@t3tools/contracts";
import {
  GENERATION_SPEED_DESCRIPTION,
  formatGenerationSpeed,
  generationModelLabel,
  generationTrackingLabel,
  mergeGenerationSpeedHistory,
} from "@t3tools/client-runtime/generation-speed";
import { formatDayShort, formatHourShort } from "@t3tools/shared/usageFormat";
import { AppText as Text } from "../../components/ui/AppText";

export function GenerationSpeedStats({
  environments,
  timeZone,
}: {
  readonly environments: readonly { label: string; summary: UsageSummary | null }[];
  readonly timeZone: string;
}) {
  const speed = useMemo(() => mergeGenerationSpeedHistory(environments), [environments]);
  const [expanded, setExpanded] = useState(false);
  if (speed.tracking.length === 0) return null;
  return (
    <View className="gap-3">
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className="font-t3-medium text-base text-foreground">Generation speed</Text>
        {speed.totals.responses > 0 ? (
          <Text className="text-lg tabular-nums text-foreground">
            {formatGenerationSpeed(speed.totals)}
          </Text>
        ) : null}
      </View>
      <Text className="text-xs text-foreground-muted">{GENERATION_SPEED_DESCRIPTION}</Text>
      {speed.tracking.map((tracking) => (
        <Text
          key={`${tracking.label}:${tracking.startedAt}`}
          className="text-xs text-foreground-muted"
        >
          {environments.length > 1 ? `${tracking.label}: ` : ""}
          {generationTrackingLabel(tracking.startedAt)}
        </Text>
      ))}
      {speed.models.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          No generation measurements in this period. New Codex and Claude responses are tracked as
          they complete.
        </Text>
      ) : (
        speed.models.map((model) => (
          <View
            key={JSON.stringify([
              model.provider,
              model.model,
              model.reasoningEffort,
              model.serviceTier,
            ])}
            className="flex-row items-center justify-between gap-4 py-2"
          >
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground">{generationModelLabel(model)}</Text>
              <Text className="text-xs capitalize text-foreground-muted">{model.provider}</Text>
            </View>
            <Text className="text-sm tabular-nums text-foreground">
              {formatGenerationSpeed(model)}
            </Text>
          </View>
        ))
      )}
      {speed.periods.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            className="py-2"
          >
            <Text className="text-sm text-foreground-secondary">
              {expanded ? "Hide" : "Show"} generation speed history
            </Text>
          </Pressable>
          {expanded
            ? speed.periods.map((period) => (
                <View
                  key={period.hourStart ?? period.day}
                  className="flex-row justify-between gap-4 py-2"
                >
                  <Text className="text-sm text-foreground-secondary">
                    {period.hourStart
                      ? formatHourShort(period.hourStart, timeZone)
                      : formatDayShort(period.day)}
                  </Text>
                  <Text className="text-sm tabular-nums text-foreground">
                    {formatGenerationSpeed(period)}
                  </Text>
                </View>
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}
