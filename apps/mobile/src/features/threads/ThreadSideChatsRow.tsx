import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useSideChats } from "../../state/entities";

/**
 * The thread's side chats, started on web or desktop, are not supported in T3 Learn mobile yet.
 */
export function ThreadSideChatsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const sideChats = useSideChats({ environmentId: props.environmentId, threadId: props.threadId });
  if (sideChats.length === 0) return null;
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2 pl-4",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="text-xs text-foreground-muted">Side chats</Text>
      <Text className="text-xs text-foreground-muted">not supported in OminaX mobile yet</Text>
    </View>
  );
}
