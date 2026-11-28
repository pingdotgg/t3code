import { useAtomValue } from "@effect/atom-react";
import type { BotWorkerRequest } from "@t3tools/client-runtime/state/thread-requests";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { botWorkerRequestsAtom } from "../../state/threads";
import { OtherThreadApproval } from "../threads/ChildThreadApprovals";

function WorkerApproval({ request }: { request: BotWorkerRequest }) {
  const gt = useGT();
  const [collapsed, setCollapsed] = useState(false);
  const { approval } = request;
  return (
    <View
      accessibilityLabel={gt("Request from {title}", { title: request.title })}
      className="mx-3.5 my-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityHint={collapsed ? gt("Show the approval") : gt("Hide the approval")}
        hitSlop={4}
        className="min-h-9 flex-row items-center gap-1.5 py-1.5"
        onPress={() => {
          void Haptics.selectionAsync();
          setCollapsed((current) => !current);
        }}
      >
        <Text
          numberOfLines={1}
          className="max-w-[40%] shrink-0 font-t3-bold text-sm text-foreground"
        >
          {request.title}
        </Text>
        <Text className="text-sm text-foreground-muted">·</Text>
        <Text numberOfLines={1} className="shrink-0 text-sm text-foreground-muted">
          <T>Needs approval</T>
        </Text>
        {collapsed ? (
          <>
            <Text className="text-sm text-foreground-muted">·</Text>
            <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground-secondary">
              {approval.detail || approval.requestKind}
            </Text>
          </>
        ) : (
          <View className="flex-1" />
        )}
        <SymbolView
          name={collapsed ? "chevron.down" : "chevron.up"}
          size={11}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
      {collapsed ? null : (
        <View className="gap-2">
          <OtherThreadApproval thread={request.thread} approval={approval} />
        </View>
      )}
    </View>
  );
}

/** The approvals the Bot's workers wait on, each answered on the worker's own thread. */
export function BotWorkerRequests({
  botRef,
  maxHeight,
}: {
  /** Null when the open thread is not a Bot. */
  botRef: ScopedThreadRef | null;
  maxHeight: DerivedValue<number>;
}) {
  const requests = useAtomValue(botWorkerRequestsAtom(botRef));
  const heightStyle = useAnimatedStyle(() => ({ maxHeight: Math.min(320, maxHeight.value / 2) }));
  if (requests.length === 0) return null;
  return (
    <Animated.View style={heightStyle} className="overflow-hidden">
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexShrink: 1 }}>
        {requests.map((request) => (
          <WorkerApproval
            key={JSON.stringify([
              request.thread.environmentId,
              request.thread.threadId,
              request.approval.requestId,
            ])}
            request={request}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}
