import { useGT, useMessages } from "gt-react-native";
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
  const messages = useMessages();
  const data = useHostResources(environmentId);
  const summary = data ? hostResourcesSummary(data, messages) : "";
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
  const gt = useGT();
  const data = useHostResources(environmentId);
  if (!data) return null;
  const updates = data.osUpdates;
  const updateNames = updates?.names ?? [];
  return (
    <SettingsSection title={gt("System")}>
      <View className="gap-1 p-4">
        {data.disk ? (
          <Text
            className={cn(
              "text-base text-foreground",
              isHostDiskLow(data) && "text-warning-foreground",
            )}
          >
            {gt("Home volume: {available} free of {total}", {
              available: formatHostBytes(data.disk.availableBytes),
              total: formatHostBytes(data.disk.totalBytes),
            })}
          </Text>
        ) : null}
        <Text className="text-base text-foreground">
          {gt("Memory: {available} free of {total}", {
            available: formatHostBytes(data.availableMemoryBytes),
            total: formatHostBytes(data.totalMemoryBytes),
          })}
        </Text>
        {data.cpuUtilization === null ? null : (
          <Text className="text-base text-foreground">
            {gt(
              "CPU: {percent}% busy on {count, plural, one {{count} core} other {{count} cores}}",
              { percent: Math.round(data.cpuUtilization * 100), count: data.cpuCount },
            )}
          </Text>
        )}
        {updates ? (
          <Text className="text-base text-foreground">
            {updates.available === 0
              ? gt("No updates in the last OS check")
              : updates.security
                ? gt(
                    "{count, plural, one {{count} OS update} other {{count} OS updates}} ({security} security)",
                    { count: updates.available, security: updates.security },
                  )
                : gt("{count, plural, one {{count} OS update} other {{count} OS updates}}", {
                    count: updates.available,
                  })}
          </Text>
        ) : null}
        {updateNames.length > 0 ? (
          <Text className="text-sm text-foreground-muted">{updateNames.join(", ")}</Text>
        ) : null}
        {data.rebootRequired ? (
          <Text className="text-base text-warning-foreground">{gt("Restart required")}</Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
