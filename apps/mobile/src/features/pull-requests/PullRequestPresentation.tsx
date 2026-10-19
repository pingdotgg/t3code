import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import type { PullRequestActor } from "@t3tools/contracts";
import IconAlertTriangle from "@tabler/icons-react-native/IconAlertTriangle";
import { Image } from "expo-image";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../components/ui/EmptyState";

export function PullRequestReadStatus(props: {
  readonly pending: boolean;
  readonly error: string | null;
}) {
  return props.pending ? (
    <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
  ) : props.error ? (
    <EmptyState title="Couldn't load this pull request" detail={props.error} variant="plain" />
  ) : null;
}

export function PullRequestConflictBadge(props: { readonly surfaceClassName: string }) {
  const { color } = useResolveClassNames("text-danger-foreground");
  const { color: surface } = useResolveClassNames(props.surfaceClassName);
  return (
    <View pointerEvents="none" className="absolute -right-1 -bottom-1">
      <IconAlertTriangle size={15} strokeWidth={2.5} color={surface} fill={surface} />
      <View className="absolute inset-0">
        <IconAlertTriangle size={15} strokeWidth={2.5} color={color} />
      </View>
    </View>
  );
}

export function PullRequestAvatar(props: {
  readonly actor: PullRequestActor | null;
  readonly size?: number;
}) {
  const size = props.size ?? 24;
  return props.actor?.avatarUrl ? (
    <Image
      source={{ uri: props.actor.avatarUrl }}
      recyclingKey={props.actor.avatarUrl}
      accessibilityLabel={props.actor.login}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="memory-disk"
    />
  ) : (
    <View
      className="items-center justify-center rounded-full bg-grouped-card"
      style={{ width: size, height: size }}
    >
      <Text className="font-t3-medium text-foreground-muted" style={{ fontSize: size * 0.45 }}>
        {props.actor?.login.slice(0, 1).toUpperCase() ?? "?"}
      </Text>
    </View>
  );
}

export function PullRequestDiffStats(props: {
  readonly additions: number;
  readonly deletions: number;
  readonly compact?: boolean;
}) {
  const textSize = props.compact ? "text-2xs" : "text-xs";
  return (
    <View className="shrink-0 flex-row items-center gap-2">
      {!props.compact || props.additions > 0 ? (
        <Text className={cn(textSize, "font-t3-medium tabular-nums text-adaptive-emerald-600-400")}>
          +{props.additions.toLocaleString()}
        </Text>
      ) : null}
      {!props.compact || props.deletions > 0 ? (
        <Text className={cn(textSize, "font-t3-medium tabular-nums text-danger-foreground")}>
          −{props.deletions.toLocaleString()}
        </Text>
      ) : null}
    </View>
  );
}
