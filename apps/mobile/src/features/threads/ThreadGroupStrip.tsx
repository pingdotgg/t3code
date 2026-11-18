import { useAtomValue } from "@effect/atom-react";
import { resolveThreadGroupFor } from "@t3tools/client-runtime/state/thread-groups";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef } from "react";
import { Platform, Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { resolveThreadListV2Status, type ThreadListV2Status } from "./threadListV2";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

function statusDotClass(status: ThreadListV2Status) {
  switch (status) {
    case "approval":
    case "input":
    case "request":
      return "bg-warning-foreground";
    case "working":
      return "bg-adaptive-sky-600-400";
    case "failed":
    case "limited":
      return "bg-danger-foreground";
    case "waiting":
      return "bg-foreground-muted";
    case "ready":
      return "bg-adaptive-emerald-600-400";
  }
}

/** The open thread's group: its lead and workers. Reads the quiet shell list, not streaming ticks. */
export function ThreadGroupStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shells = useAtomValue(steadyNavigationThreadShellsAtom);
  const openLinkedThread = useOpenLinkedThread();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const group = resolveThreadGroupFor(shells, props.environmentId, props.threadId);
  if (group === null) return null;
  const members = [
    { shell: group.parent, lead: true },
    ...group.workers.map((shell) => ({ shell, lead: false })),
  ];
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2 pl-4",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <SymbolView name="person.2" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="text-xs text-foreground-muted">Group</Text>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-1"
      >
        <View className="flex-row gap-1 pr-4">
          {members.map(({ shell, lead }) => {
            const current = shell.id === props.threadId;
            const status = resolveThreadListV2Status(shell);
            const needsInput = status === "approval" || status === "input" || status === "request";
            return (
              <Pressable
                // The current chip remounts when it changes, so its layout scrolls it into view.
                key={`${shell.id}:${current}`}
                accessibilityRole="button"
                accessibilityState={{ selected: current }}
                accessibilityLabel={`Open ${shell.title}${lead ? ", lead" : ""}${needsInput ? ", needs input" : ""}`}
                disabled={current}
                className={cn(
                  "max-w-48 flex-row items-center gap-1.5 rounded-full px-2.5 py-1",
                  current ? "border border-foreground-muted bg-subtle" : "bg-subtle",
                )}
                onLayout={
                  current
                    ? (event) =>
                        scrollRef.current?.scrollTo({
                          x: Math.max(0, event.nativeEvent.layout.x - 16),
                          animated: false,
                        })
                    : undefined
                }
                onPress={() =>
                  openLinkedThread({ environmentId: shell.environmentId, threadId: shell.id })
                }
              >
                <View className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass(status))} />
                <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                  {shell.title}
                </Text>
                {lead || current ? (
                  <Text className="text-xs text-foreground-muted">{lead ? "lead" : "you"}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
