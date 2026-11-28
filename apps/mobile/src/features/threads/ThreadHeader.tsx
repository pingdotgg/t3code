import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarTitleAvatar } from "../../components/ui/AppBar.types";
import { BotHeaderAvatar, useOpenBotThread } from "../bots/BotHeaderAvatar";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
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
  /** The thread's Bot: the thread itself, or the Bot it works for. */
  readonly bot?: {
    readonly ref: ScopedThreadRef;
    readonly name: string;
    readonly isWorker: boolean;
  } | null;
  readonly onOpenBotInspector?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const openBotThread = useOpenBotThread();
  const { bot, onOpenBotInspector } = props;
  const botPanelVisible = props.inspectorMode === "bot" && panes.auxiliaryPaneVisible;
  const titleAvatar: AppBarTitleAvatar | undefined =
    bot == null
      ? undefined
      : bot.isWorker
        ? {
            content: <BotHeaderAvatar botRef={bot.ref} />,
            accessibilityLabel: gt("Open {name}", { name: bot.name }),
            onPress: () => openBotThread(bot.ref),
          }
        : onOpenBotInspector === undefined
          ? undefined
          : {
              content: <BotHeaderAvatar botRef={bot.ref} />,
              accessibilityLabel: botPanelVisible
                ? gt("Close Bot details")
                : gt("Open Bot details"),
              onPress: botPanelVisible ? toggleAuxiliaryPane : onOpenBotInspector,
            };
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      titleAvatar={titleAvatar}
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
