import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import {
  THREAD_SUBAGENT_STATUS_LABELS,
  visibleThreadSubagentRows,
  type ThreadSubagentCounts,
} from "@t3tools/client-runtime/state/thread-subagents";
import type { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { environmentThreadShells } from "../../state/threads";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Show root counts or an inline disclosure for a nested branch. */
function SubagentToggle({
  thread,
  counts,
  expanded,
  onToggle,
  selected = false,
  disclosureOnly = false,
}: {
  thread: EnvironmentThreadShell;
  counts: ThreadSubagentCounts;
  expanded: boolean;
  onToggle: () => void;
  selected?: boolean;
  disclosureOnly?: boolean;
}) {
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`Subagents for ${thread.title}: ${counts.label}`}
      accessibilityHint={expanded ? "Collapses the subagents." : "Expands the subagents."}
      hitSlop={12}
      onPress={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="min-h-5 flex-row items-center gap-1 self-start"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {disclosureOnly ? null : (
        <>
          <SymbolView
            name="person.2"
            size={12}
            type="monochrome"
            tintColorClassName={tintColorClassName}
          />
          <Text className={cn("text-xs tabular-nums", textClassName)}>
            {counts.running} running · {counts.finished} finished
          </Text>
        </>
      )}
      <SymbolView
        name={expanded ? "chevron.up" : "chevron.down"}
        size={10}
        type="monochrome"
        tintColorClassName={tintColorClassName}
      />
    </Pressable>
  );
}

/** Keep the disclosure inside the row while its children extend below the row. */
export function useThreadSubagents(thread: EnvironmentThreadShell, selected = false) {
  const key = `${thread.environmentId}:${thread.id}`;
  const [expansion, setExpansion] = useState(() => ({ key, ids: new Set<ThreadId>() }));
  const expandedIds = expansion.key === key ? expansion.ids : new Set<ThreadId>();
  const expanded = expandedIds.has(thread.id);
  const toggleThread = (id: ThreadId) => {
    setExpansion((current) => {
      const ids = new Set(current.key === key ? current.ids : []);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { key, ids };
    });
  };
  const model = useAtomValue(
    environmentThreadShells.subagentTreeAtom({
      environmentId: thread.environmentId,
      threadId: thread.id,
    }),
  );
  if (model.rows.length === 0) return { toggle: null, tree: null };

  return {
    toggle: (
      <SubagentToggle
        thread={thread}
        counts={model}
        expanded={expanded}
        onToggle={() => toggleThread(thread.id)}
        selected={selected}
      />
    ),
    tree: expanded ? (
      <View className="mx-5 mb-1 border-l border-border-subtle">
        {visibleThreadSubagentRows(model.rows, expandedIds).map(
          ({ thread: agent, depth, status, descendants }) => (
            <View
              key={agent.id}
              className="py-1"
              style={{ paddingLeft: (Math.min(depth, 4) + 1) * 12 }}
            >
              <View className="absolute left-0 top-3 w-2 border-t border-border-subtle" />
              <View className="min-h-5 flex-row items-center gap-2">
                {descendants.total > 0 ? (
                  <SubagentToggle
                    thread={agent}
                    counts={descendants}
                    expanded={expandedIds.has(agent.id)}
                    onToggle={() => toggleThread(agent.id)}
                    disclosureOnly
                  />
                ) : (
                  <View className="w-2.5" />
                )}
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                  {agent.title}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {THREAD_SUBAGENT_STATUS_LABELS[status]}
                </Text>
              </View>
            </View>
          ),
        )}
      </View>
    ) : null,
  };
}
