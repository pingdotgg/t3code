import { Toolbar } from "../../components/ui/Toolbar";
import { createNativeHeaderMenu } from "../../components/ui/nativeHeaderMenu.ios";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { ProjectScript } from "@t3tools/contracts";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";

import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";
import {
  THREAD_GIT_GLYPH,
  THREAD_WORKSPACE_GLYPH,
  threadGitMenuDefinition,
  useThreadGitControlModel,
  useThreadGitMenuDefinition,
  type ThreadGitMenuProps,
} from "./threadGitActions";

export type { ThreadGitMenuProps } from "./threadGitActions";
export { useThreadGitMenuDefinition } from "./threadGitActions";

type HeaderItem = Record<string, unknown>;
type HeaderItems = HeaderItem[];
type ThreadGitHeaderActionItems = {
  readonly terminal: HeaderItem;
  readonly workspace: HeaderItem;
  readonly git: HeaderItem;
  readonly mergeBack: HeaderItem | null;
};

type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly auxiliaryPaneControl?: {
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly showActionControls?: boolean;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

function nativeMenuItems(items: ReadonlyArray<AppBarMenuItem>): HeaderItems {
  return items.flatMap((item) =>
    "items" in item
      ? nativeMenuItems(item.items)
      : [
          {
            description: item.subtitle,
            disabled: item.disabled,
            ...(item.icon ? { icon: { name: item.icon, type: "sfSymbol" as const } } : {}),
            label: item.title,
            onPress: item.onPress,
            type: "action" as const,
          },
        ],
  );
}

function useThreadGitHeaderActionItems(props: ThreadGitControlsProps): ThreadGitHeaderActionItems {
  const model = useThreadGitControlModel(props);
  const gitMenu = threadGitMenuDefinition(props, model);

  return {
    terminal: {
      accessibilityLabel: "Open terminal",
      disabled: !props.canOpenTerminal,
      icon: { name: "terminal", type: "sfSymbol" },
      identifier: "thread-right-terminal",
      label: "Terminal",
      menu: {
        items: [
          ...props.projectScripts.map((script) => ({
            description: script.command,
            disabled: !props.canOperateTerminal,
            icon: { name: projectScriptMenuIcon(script.icon), type: "sfSymbol" as const },
            label: projectScriptMenuLabel(script),
            onPress: () => void props.onRunProjectScript(script),
            type: "action" as const,
          })),
          ...(props.projectScripts.length === 0
            ? [
                {
                  description: "This project has no saved scripts yet",
                  disabled: true,
                  icon: { name: "play", type: "sfSymbol" as const },
                  label: "No project scripts",
                  onPress: () => {},
                  type: "action" as const,
                },
              ]
            : []),
          ...props.terminalSessions.map((session) => ({
            description: [
              getTerminalStatusLabel({
                status: session.status,
                hasRunningSubprocess: session.hasRunningSubprocess,
              }),
              basename(session.cwd),
            ]
              .filter(Boolean)
              .join(" · "),
            icon: { name: "terminal", type: "sfSymbol" as const },
            label: session.displayLabel,
            onPress: () => props.onOpenTerminal(session.terminalId),
            type: "action" as const,
          })),
          {
            description: "Start another shell for this thread",
            disabled: !props.canOperateTerminal,
            icon: { name: "plus", type: "sfSymbol" },
            label: "Open new terminal",
            onPress: props.onOpenNewTerminal,
            type: "action",
          },
        ],
        title: "Terminal",
      },
      sharesBackground: true,
      type: "menu",
      variant: "plain",
    },
    workspace: {
      accessibilityLabel: "Open workspace",
      disabled: !props.canOpenFiles,
      icon: { name: THREAD_WORKSPACE_GLYPH, type: "sfSymbol" },
      identifier: "thread-right-workspace",
      label: "Workspace",
      onPress: model.openWorkspace,
      sharesBackground: true,
      type: "button",
      variant: "plain",
    },
    git: {
      accessibilityLabel: "Git actions",
      icon: { name: THREAD_GIT_GLYPH, type: "sfSymbol" },
      identifier: "thread-right-git",
      label: "Git",
      menu: { items: nativeMenuItems(gitMenu.items), title: gitMenu.title },
      sharesBackground: true,
      type: "menu",
      variant: "plain",
    },
    mergeBack: props.onMergeBack
      ? {
          accessibilityLabel: "Merge back to source",
          icon: { name: PullRequestGlyph.merged, type: "sfSymbol" },
          identifier: "thread-right-merge-back",
          label: "Merge back",
          onPress: props.onMergeBack,
          sharesBackground: true,
          type: "button",
          variant: "plain",
        }
      : null,
  };
}

export function useThreadGitRightHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return [
    ...(actionItems.mergeBack ? [actionItems.mergeBack] : []),
    actionItems.workspace,
    actionItems.git,
    actionItems.terminal,
  ] as HeaderItems;
}

export function useThreadGitCenterHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return [
    actionItems.workspace,
    actionItems.git,
    ...(actionItems.mergeBack ? [actionItems.mergeBack] : []),
    actionItems.terminal,
  ] as HeaderItems;
}

export function ThreadGitControls(props: ThreadGitControlsProps) {
  const model = useThreadGitControlModel(props);
  const showActionControls = props.showActionControls ?? true;

  if (!showActionControls) {
    return null;
  }

  return (
    <Toolbar placement="right">
      {props.auxiliaryPaneControl ? (
        <Toolbar.Button
          accessibilityLabel={props.auxiliaryPaneControl.accessibilityLabel}
          icon="sidebar.right"
          onPress={props.auxiliaryPaneControl.onPress}
          separateBackground
        />
      ) : null}
      <Toolbar.Menu
        accessibilityLabel="Open terminal"
        icon="terminal"
        disabled={!props.canOpenTerminal}
        separateBackground
      >
        {props.projectScripts.length > 0 ? (
          props.projectScripts.map((script) => (
            <Toolbar.MenuAction
              key={script.id}
              icon={projectScriptMenuIcon(script.icon)}
              disabled={!props.canOperateTerminal}
              onPress={() => void props.onRunProjectScript(script)}
              subtitle={script.command}
            >
              <Toolbar.Label>{projectScriptMenuLabel(script)}</Toolbar.Label>
            </Toolbar.MenuAction>
          ))
        ) : (
          <Toolbar.MenuAction
            icon="play"
            disabled
            onPress={() => {}}
            subtitle="This project has no saved scripts yet"
          >
            <Toolbar.Label>No project scripts</Toolbar.Label>
          </Toolbar.MenuAction>
        )}
        {props.terminalSessions.map((session) => (
          <Toolbar.MenuAction
            key={session.terminalId}
            icon="terminal"
            onPress={() => props.onOpenTerminal(session.terminalId)}
            subtitle={[
              getTerminalStatusLabel({
                status: session.status,
                hasRunningSubprocess: session.hasRunningSubprocess,
              }),
              basename(session.cwd),
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <Toolbar.Label>{session.displayLabel}</Toolbar.Label>
          </Toolbar.MenuAction>
        ))}
        <Toolbar.MenuAction
          icon="plus"
          disabled={!props.canOperateTerminal}
          onPress={props.onOpenNewTerminal}
          subtitle="Start another shell for this thread"
        >
          <Toolbar.Label>Open new terminal</Toolbar.Label>
        </Toolbar.MenuAction>
      </Toolbar.Menu>
      <Toolbar.Button
        accessibilityLabel="Open workspace"
        disabled={!props.canOpenFiles}
        icon={THREAD_WORKSPACE_GLYPH}
        onPress={model.openWorkspace}
        separateBackground
      />
      {createNativeHeaderMenu(threadGitMenuDefinition(props, model))}
    </Toolbar>
  );
}

export function ThreadGitMenu(props: ThreadGitMenuProps) {
  const menu = useThreadGitMenuDefinition(props);
  return menu ? createNativeHeaderMenu(menu) : null;
}
