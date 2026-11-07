import {
  formatHostBytes,
  hostResourcesSummary,
  isHostDiskLow,
} from "@t3tools/client-runtime/host-summary";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "../settings/components/SettingsSection";

function useHostResources(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  ).data;
}

/** One line for environment pickers; pass null to skip sampling a disconnected environment. */
export function useEnvironmentHostSummary(environmentId: EnvironmentId | null) {
  const data = useHostResources(environmentId);
  const summary = data ? hostResourcesSummary(data) : "";
  if (!data || !summary) return null;
  return { summary, warning: isHostDiskLow(data) || data.rebootRequired === true };
}

export function EnvironmentHostSummaryText({
  summary,
  warning,
}: {
  readonly summary: string;
  readonly warning: boolean;
}) {
  return (
    <Text
      className={cn("text-xs text-foreground-muted", warning && "text-warning-foreground")}
      numberOfLines={1}
    >
      {summary}
    </Text>
  );
}

export function EnvironmentSystemSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const data = useHostResources(environmentId);
  if (!data) return null;
  const updates = data.osUpdates;
  const updateNames = updates?.names ?? [];
  return (
    <SettingsSection title="System">
      <View className="gap-1 p-4">
        {data.disk ? (
          <Text
            className={cn(
              "text-base text-foreground",
              isHostDiskLow(data) && "text-warning-foreground",
            )}
          >
            Disk: {formatHostBytes(data.disk.availableBytes)} free of{" "}
            {formatHostBytes(data.disk.totalBytes)}
          </Text>
        ) : null}
        <Text className="text-base text-foreground">
          Memory: {formatHostBytes(data.availableMemoryBytes)} free of{" "}
          {formatHostBytes(data.totalMemoryBytes)}
        </Text>
        {data.cpuUtilization === null ? null : (
          <Text className="text-base text-foreground">
            CPU: {Math.round(data.cpuUtilization * 100)}% busy on {data.cpuCount} cores
          </Text>
        )}
        {updates ? (
          <Text className="text-base text-foreground">
            {updates.available === 0
              ? "No updates in the last OS check"
              : `${updates.available} OS ${updates.available === 1 ? "update" : "updates"}${
                  updates.security ? ` (${updates.security} security)` : ""
                }`}
          </Text>
        ) : null}
        {updateNames.length > 0 ? (
          <Text className="text-sm text-foreground-muted">{updateNames.join(", ")}</Text>
        ) : null}
        {data.rebootRequired ? (
          <Text className="text-base text-warning-foreground">Restart required</Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
