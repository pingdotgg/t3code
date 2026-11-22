import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { NeedsYouReason } from "@t3tools/client-runtime/state/thread-needs-you";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import {
  ConnectionStatusDot,
  type ConnectionStatusDotState,
} from "../connection/ConnectionStatusDot";

export function HomeSectionHeading(props: { readonly label: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="px-5 pb-1.5 pt-3 font-t3-bold text-2xs uppercase tracking-[0.5px] text-foreground-tertiary"
    >
      {props.label}
    </Text>
  );
}

/**
 * Threads waiting on the user, from every environment and project, above the list. Rows carry
 * shell data only and have no swipe actions; the same thread keeps its row below.
 */
export function HomeNeedsYouSection(props: {
  readonly entries: ReadonlyArray<{
    readonly thread: EnvironmentThreadShell;
    readonly reason: NeedsYouReason;
  }>;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const gt = useGT();
  if (props.entries.length === 0) return null;
  const reasonLabel = (reason: NeedsYouReason) =>
    reason === "approval"
      ? gt("wants approval", {
          $context: "thread list: a thread waits for the user to approve an action",
        })
      : reason === "input"
        ? gt("asked a question", { $context: "thread list: a thread waits for the user's answer" })
        : gt("guest message waiting", {
            $context: "thread list: a guest's message waits for the owner's approval",
          });
  return (
    <View>
      <HomeSectionHeading label={gt("Needs you · {count}", { count: props.entries.length })} />
      {props.entries.map(({ thread, reason }) => {
        const key = scopedThreadKey(thread.environmentId, thread.id);
        const project = props.projectByKey.get(
          scopedProjectKey(thread.environmentId, thread.projectId),
        );
        const meta = [project?.title, reasonLabel(reason)].filter(Boolean).join(" · ");
        const selected = key === props.selectedThreadKey;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={gt("{title}, {reason}", { title: thread.title, reason: meta })}
            onPress={() => props.onSelectThread(thread)}
            className={cn(
              "min-h-[52px] flex-row items-center gap-3 px-5 py-1.5 active:opacity-70",
              selected ? "bg-thread-selected" : "bg-warning",
            )}
          >
            <View className="size-2 rounded-full bg-warning-foreground" />
            <View className="min-w-0 flex-1">
              <Text className="font-t3-medium text-base text-foreground" numberOfLines={1}>
                {thread.title}
              </Text>
              <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
                {meta}
              </Text>
            </View>
          </Pressable>
        );
      })}
      <HomeSectionHeading label={gt("Recent", { $context: "thread list section heading" })} />
    </View>
  );
}

function environmentRouteLabel(environment: {
  readonly isRelayManaged: boolean;
  readonly displayUrl: string;
}): string | null {
  if (environment.isRelayManaged) return "T3 Connect";
  const url = environment.displayUrl.trim();
  return url ? url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "") : null;
}

/** The environment in view, its connection and its route; opens the environment settings. */
export function HomeEnvironmentChip(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connectionState: ConnectionStatusDotState;
    readonly isRelayManaged: boolean;
    readonly displayUrl: string;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  if (props.environments.length === 0) return null;
  const shown =
    props.environments.find(
      (environment) => environment.environmentId === props.selectedEnvironmentId,
    ) ?? (props.environments.length === 1 ? props.environments[0] : undefined);
  const connected = props.environments.filter(
    (environment) => environment.connectionState === "connected",
  ).length;
  const label = shown
    ? [shown.label, environmentRouteLabel(shown)].filter(Boolean).join(" · ")
    : gt("{connected} of {count} environments connected", {
        connected,
        count: props.environments.length,
      });
  const state: ConnectionStatusDotState = shown
    ? shown.connectionState
    : connected === props.environments.length
      ? "connected"
      : connected > 0
        ? "reconnecting"
        : "offline";
  return (
    <View className="flex-row px-5 pb-1 pt-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={gt("Opens environment settings")}
        onPress={props.onPress}
        hitSlop={6}
        className="h-8 max-w-full flex-row items-center gap-2 rounded-lg bg-subtle-strong px-2.5 active:opacity-70"
      >
        <ConnectionStatusDot state={state} pulse={false} size={8} />
        <Text className="shrink text-sm text-foreground-secondary" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}
