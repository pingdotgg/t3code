import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type EnvironmentId,
  type ProjectId,
  type PullRequestActor,
} from "@t3tools/contracts";
import IconAlertTriangle from "@tabler/icons-react-native/IconAlertTriangle";
import { Image } from "expo-image";
import { useGT } from "gt-react-native";
import { use, type ReactNode } from "react";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAssetUrlState } from "../../state/assets";
import { useProject } from "../../state/entities";
import { PullRequestMediaContext } from "./PullRequestMedia";
import type { PullRequestMediaLocation } from "./pullRequestMediaSource";

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

/** Avatars inside are fetched through the project's environment. */
export function PullRequestProjectMedia(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly children: ReactNode;
}) {
  const cwd = useProject({
    environmentId: props.environmentId,
    projectId: props.projectId,
  })?.workspaceRoot;
  return (
    <PullRequestMediaContext value={cwd ? { environmentId: props.environmentId, cwd } : null}>
      {props.children}
    </PullRequestMediaContext>
  );
}

export function PullRequestAvatar(props: {
  readonly actor: PullRequestActor | null;
  readonly size?: number;
}) {
  const media = use(PullRequestMediaContext);
  const avatarUrl = props.actor?.avatarUrl || null;
  // A host that shows avatars only to its signed-in users is fetched through the server.
  const fetchUrl =
    avatarUrl === null ? undefined : sourceControlClients.mediaUrl(avatarUrl)?.fetchUrl;
  if (fetchUrl === undefined) {
    return <AvatarImage actor={props.actor} uri={avatarUrl} size={props.size} />;
  }
  return media === null ? (
    <AvatarImage actor={props.actor} uri={null} size={props.size} />
  ) : (
    <HostAvatar actor={props.actor} media={media} fetchUrl={fetchUrl} size={props.size} />
  );
}

function HostAvatar(props: {
  readonly actor: PullRequestActor | null;
  readonly media: PullRequestMediaLocation;
  readonly fetchUrl: string;
  readonly size: number | undefined;
}) {
  const asset = useAssetUrlState(props.media.environmentId, {
    _tag: SOURCE_CONTROL_MEDIA_ASSET,
    cwd: props.media.cwd,
    url: props.fetchUrl,
  });
  return (
    <AvatarImage
      actor={props.actor}
      uri={asset._tag === "Success" ? asset.url : null}
      size={props.size}
    />
  );
}

function AvatarImage(props: {
  readonly actor: PullRequestActor | null;
  readonly uri: string | null;
  readonly size: number | undefined;
}) {
  const size = props.size ?? 24;
  return props.uri ? (
    <Image
      source={{ uri: props.uri }}
      recyclingKey={props.uri}
      accessibilityLabel={props.actor?.login}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="memory-disk"
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
