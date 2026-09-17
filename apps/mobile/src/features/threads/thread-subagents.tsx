import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadShells } from "../../state/threads";
import { THREAD_SUBAGENT_STATUS_LABELS } from "@t3tools/client-runtime/state/thread-subagents";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export const ThreadSubagents = memo(function ThreadSubagents({
  thread,
}: {
  thread: EnvironmentThreadShell;
}) {
  const [expanded, setExpanded] = useState(false);
  const model = useAtomValue(
    environmentThreadShells.subagentTreeAtom({
      environmentId: thread.environmentId,
      threadId: thread.id,
    }),
  );
  const threadTitle = thread.title;
  if (model.rows.length === 0) return null;
  return (
    <View className="mx-3 mb-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Subagents for ${threadTitle}: ${model.label}`}
        accessibilityHint={expanded ? "Collapses the subagents." : "Expands the subagents."}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 flex-row flex-wrap items-center gap-x-2 rounded-lg border border-border-subtle px-2 py-1"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text className="text-xs font-t3-medium text-foreground-muted">Subagents</Text>
        <Text className="flex-1 text-xs tabular-nums text-foreground-muted">{model.label}</Text>
        <Text className="text-xs text-foreground-muted">{expanded ? "Hide" : "Show"}</Text>
      </Pressable>
      {expanded ? (
        <View className="ml-2 mt-1 border-l border-border-subtle pl-2">
          {model.rows.map(({ thread: agent, depth, status }) => (
            <View
              key={agent.id}
              className="flex-row items-center gap-2 py-1"
              style={{ paddingLeft: Math.min(depth, 4) * 10 }}
            >
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {agent.title}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {THREAD_SUBAGENT_STATUS_LABELS[status]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});
