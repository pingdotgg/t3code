import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, Pressable, ScrollView, View } from "react-native";

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
    <View className={cn("px-3 py-2", Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen")}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, gap: 8 }}
      >
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
              className={cn(
                "min-h-[44px] min-w-64 flex-1 flex-row items-center gap-2 rounded-xl bg-subtle px-3 active:opacity-60",
                sideChats.length > 1 && "max-w-80",
              )}
              onPress={() =>
                openLinkedThread({ environmentId: props.environmentId, threadId: sideChat.id })
              }
            >
              <SymbolView
                name="bubble.left.and.bubble.right"
                size={14}
                tintColorClassName="accent-foreground-muted"
              />
              <Text className="text-xs text-foreground-muted">Side chat</Text>
              <View className="h-4 w-px bg-border" />
              {needs === null ? null : (
                <View
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    needs === "approval" ? "bg-warning-foreground" : "bg-adaptive-indigo-600-300",
                  )}
                />
              )}
              <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                {sideChat.title}
              </Text>
              <SymbolView
                name="chevron.right"
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
