import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { THREAD_SUBAGENT_STATUS_LABELS } from "@t3tools/client-runtime/state/thread-subagents";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { environmentThreadShells } from "../../state/threads";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Keep the disclosure inside the row while its children extend below the row. */
export function useThreadSubagents(thread: EnvironmentThreadShell, selected = false) {
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const key = `${thread.environmentId}:${thread.id}`;
  const expanded = expandedThread === key;
  const model = useAtomValue(
    environmentThreadShells.subagentTreeAtom({
      environmentId: thread.environmentId,
      threadId: thread.id,
    }),
  );
  if (model.rows.length === 0) return { toggle: null, tree: null };
  const textClassName = selected
    ? Platform.OS === "android"
      ? "text-thread-selected-foreground-muted"
      : "text-user-bubble-foreground-muted"
    : "text-foreground-muted";
  const tintColorClassName = selected
    ? Platform.OS === "android"
      ? "accent-thread-selected-foreground-muted"
      : "accent-user-bubble-foreground-muted"
    : "accent-foreground-muted";

  return {
    toggle: (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Subagents for ${thread.title}: ${model.label}`}
        accessibilityHint={expanded ? "Collapses the subagents." : "Expands the subagents."}
        hitSlop={12}
        onPress={(event) => {
          event.stopPropagation();
          setExpandedThread(expanded ? null : key);
        }}
        className="min-h-5 flex-row items-center gap-1"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="person.2"
          size={12}
          type="monochrome"
          tintColorClassName={tintColorClassName}
        />
        <Text className={cn("text-xs tabular-nums", textClassName)}>
          {model.running} running · {model.finished} finished
        </Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={10}
          type="monochrome"
          tintColorClassName={tintColorClassName}
        />
      </Pressable>
    ),
    tree: expanded ? (
      <View className="mx-5 mb-1 border-l border-border-subtle">
        {model.rows.map(({ thread: agent, depth, status }) => (
          <View
            key={agent.id}
            className="flex-row items-center gap-2 py-1"
            style={{ paddingLeft: (Math.min(depth, 4) + 1) * 12 }}
          >
            <View className="absolute left-0 top-1/2 w-2 border-t border-border-subtle" />
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
              {agent.title}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {THREAD_SUBAGENT_STATUS_LABELS[status]}
            </Text>
          </View>
        ))}
      </View>
    ) : null,
  };
}
