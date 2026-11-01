import type {
  ChildStatusBucket,
  ChildStatusCounts,
} from "@t3tools/client-runtime/state/child-status-counts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AgentAvatar } from "../../components/AgentAvatar";
import {
  CHILD_STATUS_CLASSES,
  ChildStatusSummaryText,
  childStatusAccessibilityLabel,
  sameChildStatusCounts,
} from "../../components/ChildStatus";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { AgentAppearance } from "../../state/agents";

export interface AgentChildAvatar {
  readonly thread: EnvironmentThreadShell;
  readonly bucket: ChildStatusBucket;
  readonly statusLabel: string;
  readonly agent: AgentAppearance | null;
}

const AVATAR_SIZE = 22;

interface AgentChildSummaryProps {
  readonly parentKey: string;
  readonly open: boolean;
  readonly counts: ChildStatusCounts;
  readonly avatars: readonly AgentChildAvatar[];
  readonly overflow: number;
  readonly onToggle: (parentKey: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}

/**
 * Who is on a card's child chats: each child's agent ringed in its state
 * colour (tap to open that chat), then the counts and a chevron that toggle
 * the child list. Rings are static.
 */
export const AgentChildSummary = memo(function AgentChildSummary(props: AgentChildSummaryProps) {
  return (
    <View className="my-0.5 me-4 ms-8 flex-row items-center ps-2">
      <View className="flex-row items-center">
        {props.avatars.map(({ thread, bucket, statusLabel, agent }, index) => {
          const name = agent?.name ?? "Chat";
          return (
            <Pressable
              key={`${thread.environmentId}:${thread.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${name} · ${thread.title} · ${statusLabel}`}
              accessibilityHint="Opens this child chat."
              onPress={() => props.onSelectThread(thread)}
              hitSlop={{ top: 8, bottom: 8 }}
              className={cn(
                "rounded-full border-2 bg-screen p-px active:opacity-60",
                CHILD_STATUS_CLASSES[bucket].ring,
                index > 0 && "-ms-1.5",
                bucket === "done" && "opacity-60",
              )}
            >
              {agent ? (
                <AgentAvatar icon={agent.icon} color={agent.color} size={AVATAR_SIZE} />
              ) : (
                <View
                  className="items-center justify-center rounded-full bg-subtle-strong"
                  style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
                >
                  <Text className="text-3xs font-t3-medium text-foreground-muted">
                    {name.slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
        {props.overflow > 0 ? (
          <View
            accessible={false}
            importantForAccessibility="no"
            className="-ms-1.5 h-7 min-w-7 items-center justify-center rounded-full border-2 border-screen bg-subtle-strong px-1"
          >
            <Text className="text-3xs font-t3-medium tabular-nums text-foreground-muted">
              +{props.overflow}
            </Text>
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={childStatusAccessibilityLabel(props.counts)}
        accessibilityState={{ expanded: props.open }}
        accessibilityHint={props.open ? "Hides the child chats." : "Shows the child chats."}
        onPress={() => props.onToggle(props.parentKey)}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-1.5 ps-2 active:opacity-60"
      >
        <ChildStatusSummaryText counts={props.counts} className="min-w-0 shrink" />
        <SymbolView
          name={props.open ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}, sameAgentChildSummaryProps);

// Rows rebuild their summaries on every board change; re-render only when what shows differs.
function sameAgentChildSummaryProps(
  left: AgentChildSummaryProps,
  right: AgentChildSummaryProps,
): boolean {
  return (
    left.parentKey === right.parentKey &&
    left.open === right.open &&
    left.overflow === right.overflow &&
    left.onToggle === right.onToggle &&
    left.onSelectThread === right.onSelectThread &&
    sameChildStatusCounts(left.counts, right.counts) &&
    left.avatars.length === right.avatars.length &&
    left.avatars.every((avatar, index) => {
      const other = right.avatars[index]!;
      return (
        avatar.thread === other.thread &&
        avatar.bucket === other.bucket &&
        avatar.statusLabel === other.statusLabel &&
        avatar.agent?.name === other.agent?.name &&
        avatar.agent?.icon === other.agent?.icon &&
        avatar.agent?.color === other.agent?.color
      );
    })
  );
}
