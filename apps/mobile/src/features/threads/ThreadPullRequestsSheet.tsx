import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { LegendList } from "@legendapp/list/react-native";
import { useGT } from "gt-react-native";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { useMemo } from "react";
import { View } from "react-native";
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
  const gt = useGT();
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
  const rowInputs = { lines, actions };
  const term = changeRequestTermKind(actions.terminology);
  const title = gt(
    "{term, select, mr {Linked merge requests} cr {Linked change requests} other {Linked pull requests}}",
    { term },
  );

  const content = (
    <View className="flex-1 bg-screen">
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling. */}
      <LegendList
        data={lines}
        keyExtractor={linkedPullRequestKey}
        extraData={rowInputs}
        renderItem={({ item, index }) => (
          <LinkedPullRequestRow
            line={item}
            separator={index < lines.length - 1}
            surfaceClassName="text-screen"
            openPullRequest={openPullRequest}
            actions={actions}
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
              {gt("{open} open · {linked} linked", { open: openCount, linked: lines.length })}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            {gt(
              "{term, select, mr {No linked merge requests.} cr {No linked change requests.} other {No linked pull requests.}}",
              { term },
            )}
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
                  accessibilityLabel: gt(
                    "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
                    { term },
                  ),
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
