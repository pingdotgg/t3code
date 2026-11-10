import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { LegendList } from "@legendapp/list/react-native";
import { threadPullRequestWatchesSuspended } from "@t3tools/shared/threadPullRequests";
import { useMemo } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useThreadSelection } from "../../state/use-thread-selection";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "./LinkedPullRequestList";
import { useLinkedPullRequestActions } from "./useLinkedPullRequestActions";

export function ThreadPullRequestsSheet(
  _props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const lines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const openCount = useMemo(
    () =>
      lines.filter((line) => line.link.snapshot === null || line.link.snapshot.state === "open")
        .length,
    [lines],
  );
  const openPullRequest = useOpenPullRequest({
    replace: true,
    context: selectedThread ?? undefined,
  });
  const actions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const watchesSuspended =
    selectedThread != null && threadPullRequestWatchesSuspended(selectedThread);
  const rowInputs = { lines, actions, watchesSuspended };
  const { singular } = actions.terminology;
  const title = `Linked ${actions.terminology.plural}`;

  const content = (
    <View className="flex-1 android:bg-sheet-solid ios:bg-screen">
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling. */}
      <LegendList
        data={lines}
        keyExtractor={linkedPullRequestKey}
        extraData={rowInputs}
        renderItem={({ item, index }) => (
          <LinkedPullRequestRow
            line={item}
            separator={index < lines.length - 1}
            surfaceClassName={Platform.OS === "ios" ? "text-screen" : "text-sheet-solid"}
            openPullRequest={openPullRequest}
            actions={actions}
            watchesSuspended={watchesSuspended}
          />
        )}
        estimatedItemSize={88}
        recycleItems
        alwaysBounceVertical
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 8,
        }}
        ListHeaderComponent={
          lines.length > 0 ? (
            <Text className="px-4 pt-2 pb-1 text-xs text-foreground-muted">
              {openCount} open · {lines.length} linked
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            No linked {actions.terminology.plural}.
          </Text>
        }
      />
    </View>
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title={title}
        onClose={() => navigation.goBack()}
        actions={
          actions.canLink
            ? [
                {
                  accessibilityLabel: `Link ${singular}`,
                  icon: "plus",
                  onPress: actions.promptLink,
                },
              ]
            : undefined
        }
      />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
