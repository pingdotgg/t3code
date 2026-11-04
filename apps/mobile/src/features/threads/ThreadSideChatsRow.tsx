import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
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
    <View className="flex-row items-center gap-2 pb-2 pl-4">
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="text-xs text-foreground-muted">Side chats</Text>
      <Text className="text-xs text-foreground-muted">not supported in T3 Learn mobile yet</Text>
    </View>
  );
}
