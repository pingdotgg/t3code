import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useSideChats } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/**
 * The thread's side chats, started on web or desktop. Each opens as a normal thread, so its
 * approvals and questions can be answered from the phone.
 */
export function ThreadSideChatsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const sideChats = useSideChats({ environmentId: props.environmentId, threadId: props.threadId });
  const openLinkedThread = useOpenLinkedThread();
  if (sideChats.length === 0) return null;
  return (
    <View className="flex-row items-center gap-2 pb-2 pl-4">
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="text-xs text-foreground-muted">Side chats</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row gap-1 pr-4">
          {sideChats.map((sideChat) => {
            const needs =
              sideChat.hasPendingApprovals || sideChat.pendingSubagentRequest === "approval"
                ? "approval"
                : sideChat.hasPendingUserInput || sideChat.pendingSubagentRequest
                  ? "input"
                  : null;
            return (
              <Pressable
                key={sideChat.id}
                accessibilityRole="button"
                accessibilityLabel={`Open side chat ${sideChat.title}${needs === null ? "" : `, needs ${needs}`}`}
                className="max-w-48 flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1"
                onPress={() =>
                  openLinkedThread({ environmentId: props.environmentId, threadId: sideChat.id })
                }
              >
                {needs === null ? null : (
                  <View
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      needs === "approval" ? "bg-warning-foreground" : "bg-adaptive-indigo-600-300",
                    )}
                  />
                )}
                <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                  {sideChat.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
