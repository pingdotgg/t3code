import { Button } from "../../components/ui/Button";
import { projectCloneDisplayName, type ProjectCloneSnapshot } from "@t3tools/contracts";
import { projectCloneProgressSummary } from "@t3tools/client-runtime/contract-labels";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { cn } from "../../lib/cn";
import { AppText as Text } from "../../components/ui/AppText";

export function ProjectCloneBanner(props: {
  readonly clone: ProjectCloneSnapshot;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { clone } = props;
  const name = projectCloneDisplayName(clone);
  if (clone.phase === "running") {
    return (
      <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
        <AppActivityIndicator size="small" />
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-sm" numberOfLines={1}>
            <T>
              Cloning <Var>{name}</Var>
            </T>
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {projectCloneProgressSummary(clone, m)}
          </Text>
        </View>
        <BannerAction label={gt("Cancel")} onPress={props.onCancel} />
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
        {cancelled
          ? gt("Cancelled cloning {name}", { name })
          : gt("Failed to clone {name}", { name })}
      </Text>
      {clone.error ? (
        <Text className="mt-0.5 text-xs text-danger-foreground" numberOfLines={3}>
          {clone.error}
        </Text>
      ) : null}
      <View className="mt-2 flex-row justify-end gap-2">
        <BannerAction label={gt("Remove project")} onPress={props.onRemove} />
        <BannerAction label={gt("Retry")} onPress={props.onRetry} />
      </View>
    </View>
  );
}

function BannerAction(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Button
      label={props.label}
      tone="secondary"
      accessibilityLabel={props.label}
      onPress={props.onPress}
    />
  );
}
