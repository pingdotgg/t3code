import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { orchestrationEnvironment } from "../../state/orchestration";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadMcpApp } from "./McpAppWebView";

type McpAppFullscreenScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly conversationThreadId?: string;
  readonly itemId: string;
  readonly revision?: string;
}>;

function useConversationThreadId(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requested: string | undefined,
): ThreadId {
  const shells = useThreadShells();
  return useMemo(
    () =>
      requested !== undefined && descendsFrom(shells, environmentId, requested, threadId)
        ? ThreadId.make(requested)
        : threadId,
    [shells, environmentId, threadId, requested],
  );
}

function descendsFrom(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  threadId: string,
  ancestorId: ThreadId,
): boolean {
  const parents = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId)
      .filter((shell) => shell.lineage.relationshipToParent === "fork")
      .map((shell) => [shell.id as string, shell.lineage.parentThreadId]),
  );
  let current: string | null | undefined = threadId;
  for (let depth = 0; depth < 64 && current != null; depth += 1) {
    if (current === ancestorId) return true;
    current = parents.get(current);
  }
  return false;
}

/** Resolve apps from stored tool calls so links cannot supply apps the call never produced. */
export function McpAppFullscreenScreen({ route }: McpAppFullscreenScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // Wait for focus before goBack; an exit under another screen must not pop that screen.
  const focused = useIsFocused();
  const exitPending = useRef(false);
  const onClose = () => {
    if (navigation.isFocused()) {
      navigation.goBack();
      return;
    }
    if (exitPending.current) return;
    exitPending.current = true;
    const unsubscribe = navigation.addListener("focus", () => {
      unsubscribe();
      navigation.goBack();
    });
  };
  const [size, setSize] = useState({ width: 0, height: 0 });
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const itemId = TurnItemId.make(params.itemId);
  const conversationThreadId = useConversationThreadId(
    environmentId,
    threadId,
    params.conversationThreadId,
  );
  const detail = useEnvironmentQuery(
    orchestrationEnvironment.turnItem({
      environmentId,
      input: {
        threadId,
        itemId,
        ...(params.revision === undefined ? {} : { revision: params.revision }),
      },
    }),
  );
  const item = detail.data?.item;
  // Keep one reference per app; refetches must not rebuild the host.
  const derived = item?.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
  const [app, setApp] = useState(derived);
  if (derived?.attachmentId !== app?.attachmentId) setApp(derived);
  const conversation = useThreadShell(scopeThreadRef(environmentId, conversationThreadId));
  const awaitingUser =
    conversation?.hasPendingApprovals === true || conversation?.hasPendingUserInput === true;
  // A request for the user is server state with no local handler to react in.
  useEffect(() => {
    if (awaitingUser && focused && !exitPending.current) navigation.goBack();
  }, [awaitingUser, focused, navigation]);

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <View className="h-11 flex-row items-center justify-between px-3">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {app?.server ?? "App"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit full screen"
          hitSlop={8}
          onPress={onClose}
        >
          <SymbolView name="xmark" size={18} tintColor="gray" />
        </Pressable>
      </View>
      <View
        className="flex-1"
        style={{ paddingBottom: insets.bottom }}
        onLayout={(event) =>
          setSize({
            width: Math.round(event.nativeEvent.layout.width),
            height: Math.round(event.nativeEvent.layout.height - insets.bottom),
          })
        }
      >
        {app === undefined ? (
          detail.data === undefined ? null : (
            <Text className="m-6 text-sm text-foreground-muted">This app cannot be shown.</Text>
          )
        ) : size.width > 0 ? (
          <ThreadMcpApp
            environmentId={environmentId}
            threadId={threadId}
            conversationThreadId={conversationThreadId}
            itemId={itemId}
            revision={params.revision ?? (item == null ? "" : turnItemDetailRevision(item))}
            app={app}
            width={size.width}
            height={size.height}
            displayMode="fullscreen"
            onExitFullscreen={onClose}
          />
        ) : null}
      </View>
    </View>
  );
}
