import {
  projectCloneDisplayName,
  projectCloneProgressSummary,
  type ProjectCloneSnapshot,
} from "@t3tools/contracts";
import { ActivityIndicator, Pressable, View } from "react-native";

import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";

/**
 * Live state of the clone that backs a freshly added project, shown above
 * the composer while the draft waits for its files. Running clones offer
 * Cancel; failed or cancelled ones offer Retry and Remove project.
 */
export function ProjectCloneBanner(props: {
  readonly clone: ProjectCloneSnapshot;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
}) {
  const { clone } = props;
  const name = projectCloneDisplayName(clone);
  if (clone.phase === "running") {
    return (
      <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
        <ActivityIndicator size="small" />
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-sm" numberOfLines={1}>
            Cloning {name}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {projectCloneProgressSummary(clone)}
          </Text>
        </View>
        <BannerAction label="Cancel" onPress={props.onCancel} />
      </View>
    );
  }
  const cancelled = clone.phase === "cancelled";
  return (
    <View
      className={cn(
        "rounded-2xl border px-3.5 py-3",
        cancelled ? "border-warning-border bg-warning" : "border-danger-border bg-danger",
      )}
    >
      <Text
        className={cn(
          "font-t3-medium text-sm",
          cancelled ? "text-warning-foreground" : "text-danger-foreground",
        )}
        numberOfLines={1}
      >
        {cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`}
      </Text>
      {clone.error ? (
        <Text className="mt-0.5 text-xs text-danger-foreground" numberOfLines={3}>
          {clone.error}
        </Text>
      ) : null}
      <View className="mt-2 flex-row justify-end gap-2">
        <BannerAction label="Remove project" onPress={props.onRemove} />
        <BannerAction label="Retry" onPress={props.onRetry} />
      </View>
    </View>
  );
}

function BannerAction(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      className="rounded-full border border-border bg-background px-3 py-1.5"
      onPress={props.onPress}
    >
      <Text className="font-t3-medium text-xs">{props.label}</Text>
    </Pressable>
  );
}
