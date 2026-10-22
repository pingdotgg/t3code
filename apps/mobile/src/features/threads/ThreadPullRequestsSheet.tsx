import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { LegendList } from "@legendapp/list/react-native";
import { useMemo } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "./LinkedPullRequestList";
import { useLinkedPullRequestActions } from "./useLinkedPullRequestActions";

const TITLE = "Linked pull requests";

export function ThreadPullRequestsSheet(
  _props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const { layout } = useAdaptiveWorkspaceLayout();
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
  const rowInputs = useMemo(() => ({ lines, actions }), [lines, actions]);

  const content = (
    <View className="flex-1 android:bg-sheet-solid ios:bg-screen">
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
          />
        )}
        estimatedItemSize={88}
        recycleItems
        alwaysBounceVertical
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
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
            No linked pull requests.
          </Text>
        }
      />
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader presentation="native" title={TITLE} onClose={() => navigation.goBack()} />
        {actions.canLink ? (
          <Toolbar placement="right">
            <Toolbar.Button
              icon="plus"
              accessibilityLabel="Link pull request"
              onPress={actions.promptLink}
            />
          </Toolbar>
        ) : null}
        {content}
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-header">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader
        title={TITLE}
        hideBottomBorder
        onBack={() => navigation.goBack()}
        actions={
          actions.canLink
            ? [
                {
                  accessibilityLabel: "Link pull request",
                  icon: "plus",
                  onPress: actions.promptLink,
                },
              ]
            : undefined
        }
      />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
