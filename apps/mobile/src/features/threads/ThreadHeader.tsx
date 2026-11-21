import { NavigationRouteContext, useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  canSnooze,
  effectiveSnoozed,
  pickSnoozePreset,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useGT, useMessages } from "gt-react-native";
import { use, useRef } from "react";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { useNowMinuteMs } from "../../lib/clock";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import { useThreadListActions } from "../home/useThreadListActions";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  /** The thread the bar can settle or un-settle. Absent while that is not possible. */
  readonly settleThread?: EnvironmentThreadShell;
  /** The server's snooze times for the settle button's menu. Absent uses the defaults. */
  readonly snoozePresets?: ReadonlyArray<SnoozePresetSetting>;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const navigation = useNavigation();
  const route = use(NavigationRouteContext);
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread } = useThreadListActions();
  const putAwayInFlight = useRef(false);
  const now = new Date(useNowMinuteMs()).toISOString();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const thread = props.settleThread;
  const settled = thread?.settledOverride === "settled";
  const snoozed = thread !== undefined && effectiveSnoozed(thread, { now });
  const presetOptions = props.snoozePresets ? { presets: props.snoozePresets } : {};
  const snoozeTimes =
    thread !== undefined && !snoozed && canSnooze(thread, { now })
      ? resolveSnoozePresets(new Date(now), presetOptions, m)
      : [];
  // The undo notice shows on the list, so only a thread opened from the list returns to it.
  const opensOverList = () => {
    const routes = navigation.getState()?.routes ?? [];
    const index = routes.findIndex((candidate) => candidate.key === route?.key);
    return index === 0 || (index > 0 && routes[index - 1]?.name === "Home");
  };
  // Beside the list, or over another page, the thread stays open and the button offers the reverse.
  const putAway = async (run: () => Promise<boolean>) => {
    if (putAwayInFlight.current) return;
    putAwayInFlight.current = true;
    const done = await run().catch(() => false);
    putAwayInFlight.current = false;
    if (done && !layout.usesSplitView && navigation.isFocused() && opensOverList()) goBack();
  };
  // The button flips before the server answers; a reverse sent then would lose to the leave.
  const reverse = (run: () => Promise<boolean>) => {
    if (!putAwayInFlight.current) void run();
  };
  const snoozeUntil = (target: EnvironmentThreadShell, presetId: string) => {
    // Resolved again at the press: a duration counts from now, and a set time may have passed.
    const preset = pickSnoozePreset({
      shown: snoozeTimes,
      id: presetId,
      now: new Date(),
      ...presetOptions,
      resolve: m,
    });
    if (preset) {
      void putAway(() => snoozeThread(target, preset.snoozedUntil));
    } else {
      Dialog.alert(
        gt("Could not snooze thread"),
        gt("That snooze time has passed. Choose another time."),
      );
    }
  };
  const holdMenu = (target: EnvironmentThreadShell): ReadonlyArray<AppBarMenuItem> => {
    if (snoozed) {
      return [
        {
          id: "unsnooze",
          title: gt("Wake thread"),
          icon: "clock",
          onPress: () => reverse(() => unsnoozeThread(target)),
        },
      ];
    }
    if (snoozeTimes.length === 0) return [];
    return [
      {
        id: "snooze",
        title: gt("Snooze until"),
        inline: true,
        items: snoozeTimes.map((preset) => ({
          id: `snooze:${preset.id}`,
          title: preset.label,
          subtitle: preset.whenLabel,
          onPress: () => snoozeUntil(target, preset.id),
        })),
      },
    ];
  };
  const actions: AppBarAction[] = [];
  if (thread) {
    const menu = holdMenu(thread);
    actions.push({
      accessibilityLabel: settled
        ? gt("Un-settle", { $context: "verb, thread action" })
        : gt("Settle", { $context: "verb, thread action" }),
      icon: settled ? "arrow.uturn.backward" : "checkmark",
      primary: true,
      separateBackground: false,
      onPress: settled
        ? () => reverse(() => unsettleThread(thread))
        : () => void putAway(() => settleThread(thread)),
      ...(menu.length > 0 ? { menu } : {}),
    });
  }
  if (props.hasThreadCwd) {
    actions.push({
      accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
      icon: "folder",
      selected: filesVisible,
      disabled: !props.gitControls.canOpenFiles,
      separateBackground: false,
      onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
    });
  }
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
