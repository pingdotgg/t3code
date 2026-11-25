import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { AssetResource, EnvironmentId, PullRequestActor } from "@t3tools/contracts";
import IconAlertTriangle from "@tabler/icons-react-native/IconAlertTriangle";
import { Image } from "expo-image";
import { useGT } from "gt-react-native";
import { useContext, useState } from "react";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { EmptyState } from "../../components/ui/EmptyState";
import { assetImageCacheKey } from "../../lib/assetImageSource";
import { useAssetUrlState } from "../../state/assets";
import { PullRequestMediaContext } from "./PullRequestMedia";
import { pullRequestMediaSource } from "./pullRequestMediaSource";

export function PullRequestReadStatus(props: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly terminology: ChangeRequestTerminology;
}) {
  const gt = useGT();
  return props.pending ? (
    <AppActivityIndicator className="my-12" colorClassName="accent-icon" />
  ) : props.error ? (
    <EmptyState
      title={gt(
        "Couldn't load this {term, select, mr {merge request} cr {change request} other {pull request}}",
        {
          term: changeRequestTermKind(props.terminology),
        },
      )}
      detail={props.error}
      variant="plain"
    />
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
  const media = useContext(PullRequestMediaContext);
  const avatarUrl = props.actor?.avatarUrl;
  const source = avatarUrl ? pullRequestMediaSource(avatarUrl, media) : null;
  const resource = source && "resource" in source ? (source.resource ?? null) : null;
  if (media !== null && resource !== null) {
    return (
      <HostAvatar
        environmentId={media.environmentId}
        resource={resource}
        actor={props.actor}
        size={size}
      />
    );
  }
  return <AvatarImage uri={avatarUrl ?? null} actor={props.actor} size={size} />;
}

function HostAvatar(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly actor: PullRequestActor | null;
  readonly size: number;
}) {
  const asset = useAssetUrlState(props.environmentId, props.resource);
  return (
    <AvatarImage
      uri={
        asset._tag === "Success"
          ? asset.url
          : asset._tag === "Failure"
            ? (props.actor?.avatarUrl ?? null)
            : null
      }
      cacheKey={
        asset._tag === "Success"
          ? assetImageCacheKey(props.environmentId, props.resource)
          : undefined
      }
      actor={props.actor}
      size={props.size}
    />
  );
}

function AvatarImage(props: {
  readonly uri: string | null;
  readonly cacheKey?: string | undefined;
  readonly actor: PullRequestActor | null;
  readonly size: number;
}) {
  const { size } = props;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  return props.uri && failedUri !== props.uri ? (
    <Image
      source={props.cacheKey ? { uri: props.uri, cacheKey: props.cacheKey } : { uri: props.uri }}
      recyclingKey={props.cacheKey ?? props.uri}
      accessibilityLabel={props.actor?.login}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="memory-disk"
      onError={() => setFailedUri(props.uri)}
    />
  ) : (
    <View
      className="items-center justify-center rounded-full bg-grouped-card"
      style={{ width: size, height: size }}
    >
      <Text className="font-t3-medium text-foreground-muted" style={{ fontSize: size * 0.45 }}>
        {props.actor ? [...props.actor.login][0]?.toUpperCase() : "?"}
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
