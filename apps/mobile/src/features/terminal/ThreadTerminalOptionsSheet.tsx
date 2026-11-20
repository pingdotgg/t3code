import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { groupedListInsets } from "../../components/ui/listMetrics";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetPane } from "../../components/ui/SheetPane";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { threadTerminalRows } from "../threads/ThreadGitControls";
import { useThreadTerminalControls } from "./useThreadTerminalControls";

type ThreadTerminalOptionsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** The thread's terminal options in a sheet, opened by the thread menu's Terminal row. */
export function ThreadTerminalOptionsSheet(_props: ThreadTerminalOptionsSheetProps) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const threadDetail = useSelectedThreadProjection();
  const controls = useThreadTerminalControls({
    thread: selectedThread,
    project: selectedThreadProject,
    serverSettings: selectedEnvironmentRuntime?.serverConfig?.settings ?? null,
    threadDetailWorktreePath: threadDetail?.projection.thread.worktreePath ?? null,
    // The terminal replaces this sheet, so closing the terminal returns to the thread.
    openTerminal: (target) => navigation.dispatch(StackActions.replace("ThreadTerminal", target)),
  });
  const rows = threadTerminalRows(controls, m);

  return (
    <SheetPane surface="sheet">
      <AppBar
        title={gt("Terminal", { $context: "screen title" })}
        subtitle={selectedThreadProject?.title}
        hideBottomBorder
        onClose={() => navigation.goBack()}
      />
      <ScreenContent>
        <NativeScrollView
          nestedScrollEnabled
          alwaysBounceVertical
          className="flex-1 bg-screen"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            ...groupedListInsets(false),
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          <ListSection>
            {rows.map((row) => (
              <ListRow
                key={row.id}
                icon={row.icon}
                label={row.title}
                description={row.subtitle}
                disabled={row.disabled}
                onPress={row.onPress}
              />
            ))}
          </ListSection>
        </NativeScrollView>
      </ScreenContent>
    </SheetPane>
  );
}
